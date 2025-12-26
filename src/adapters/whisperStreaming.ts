import { Readable } from 'node:stream';
import { WebSocket } from 'ws';
import type { BatchResult, PartialTranscript, StreamingOptions, StreamingSession, TranscriptWord } from '../types.js';
import { BaseAdapter } from './base.js';
import { getWhisperStreamingHttpUrl, getWhisperStreamingWsUrl } from '../utils/whisperStreamingConfig.js';
import { waitForWhisperStreamingReady } from '../utils/whisperStreamingHealth.js';

const DEFAULT_MODEL = 'small';
const WS_OPEN_TIMEOUT_MS = 10_000;
const WS_IDLE_SEND_TIMEOUT_MS = 10_000;
const BATCH_HARD_TIMEOUT_MS = 5 * 60 * 1000; // 5m
const BATCH_IDLE_TIMEOUT_MS = 30_000;

type WhisperWordSource = {
  start?: number;
  end?: number;
  startSec?: number;
  endSec?: number;
  t0?: number;
  t1?: number;
  word?: string;
  text?: string;
  confidence?: number;
  probability?: number;
};

interface WhisperSegment {
  words?: WhisperWordSource[];
}

interface WhisperStreamingMessage {
  text?: string;
  partial?: string;
  transcript?: string;
  transcription?: string;
  result?: string;
  is_final?: boolean;
  isFinal?: boolean;
  final?: boolean;
  done?: boolean;
  complete?: boolean;
  type?: string;
  words?: WhisperWordSource[];
  segments?: WhisperSegment[];
  [key: string]: unknown;
}

interface FetchDuplexInit extends RequestInit {
  duplex?: 'half';
}

const normalizeWhisperWord = (word: WhisperWordSource): TranscriptWord => ({
  startSec: Number(word.startSec ?? word.start ?? word.t0 ?? 0),
  endSec: Number(word.endSec ?? word.end ?? word.t1 ?? 0),
  text: String(word.text ?? word.word ?? '').trim(),
  confidence: typeof word.confidence === 'number' ? word.confidence : undefined,
});

const extractWordSources = (value: unknown): WhisperWordSource[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is WhisperWordSource => typeof item === 'object' && item !== null);
};

const wordsFromMessage = (message: WhisperStreamingMessage): TranscriptWord[] | undefined => {
  const direct = extractWordSources(message.words);
  if (direct) return direct.map(normalizeWhisperWord);
  if (Array.isArray(message.segments)) {
    const segmentWords = message.segments.flatMap((segment) => extractWordSources(segment?.words) ?? []);
    if (segmentWords.length > 0) {
      return segmentWords.map(normalizeWhisperWord);
    }
  }
  return undefined;
};
function getModel(): string {
  return process.env.WHISPER_MODEL ?? DEFAULT_MODEL;
}

function toPartialTranscript(message: unknown): PartialTranscript | null {
  if (!message || typeof message !== 'object') return null;
  const payload = message as WhisperStreamingMessage;
  const text =
    payload.text ??
    payload.partial ??
    payload.transcript ??
    payload.transcription ??
    payload.result ??
    '';

  const isFinal =
    Boolean(payload.is_final ?? payload.isFinal ?? payload.final ?? payload.done ?? payload.complete) ||
    payload.type === 'final' ||
    payload.type === 'completed';

  const words = wordsFromMessage(payload);

  return {
    provider: 'whisper_streaming',
    isFinal: Boolean(isFinal),
    text: typeof text === 'string' ? text : '',
    words,
    timestamp: Date.now(),
    channel: 'mic',
  };
}

export class WhisperStreamingAdapter extends BaseAdapter {
  id = 'whisper_streaming' as const;
  supportsStreaming = true;
  supportsBatch = true;

  async startStreaming(opts: StreamingOptions): Promise<StreamingSession> {
    await waitForWhisperStreamingReady();

    const ws = new WebSocket(getWhisperStreamingWsUrl());
    const model = getModel();

    const listeners: {
      data: ((t: PartialTranscript) => void)[];
      error: ((err: Error) => void)[];
      close: (() => void)[];
    } = { data: [], error: [], close: [] };

    let idleTimer: NodeJS.Timeout | null = null;

    const fail = (err: Error) => {
      listeners.error.forEach((cb) => cb(err));
      ws.close();
    };

    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fail(new Error('whisper_streaming send idle timeout')), WS_IDLE_SEND_TIMEOUT_MS);
    };

    const wsReady = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('whisper_streaming connection timeout'));
      }, WS_OPEN_TIMEOUT_MS);

      ws.once('open', () => {
        clearTimeout(timer);
        try {
          ws.send(
            JSON.stringify({
              language: opts.language,
              task: 'transcribe',
              model,
            })
          );
          resetIdle();
          resolve();
        } catch (err) {
          reject(err as Error);
        }
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      ws.once('close', () => {
        clearTimeout(timer);
        reject(new Error('whisper_streaming socket closed before ready'));
      });
    });
    wsReady.catch((err) => fail(err as Error));

    ws.on('message', (data) => {
      try {
        resetIdle();
        const parsed = typeof data === 'string' ? JSON.parse(data) : JSON.parse(data.toString());
        const transcript = toPartialTranscript(parsed);
        if (transcript) {
          listeners.data.forEach((cb) => cb(transcript));
        }
      } catch (err) {
        listeners.error.forEach((cb) => cb(err as Error));
      }
    });

    ws.on('error', (err) => {
      listeners.error.forEach((cb) => cb(err as Error));
    });

    ws.on('close', () => {
      if (idleTimer) clearTimeout(idleTimer);
      listeners.close.forEach((cb) => cb());
    });

    const controller = {
      async sendAudio(chunk: ArrayBufferLike, _meta?: { captureTs?: number }) {
        await wsReady;
        resetIdle();
        ws.send(Buffer.from(chunk));
      },
      async end() {
        if (idleTimer) clearTimeout(idleTimer);
        ws.close();
      },
      async close() {
        if (idleTimer) clearTimeout(idleTimer);
        ws.close();
      },
    };

    return {
      controller,
      onData(cb) {
        listeners.data.push(cb);
      },
      onError(cb) {
        listeners.error.push(cb);
      },
      onClose(cb) {
        listeners.close.push(cb);
      },
    };
  }

  async transcribeFileFromPCM(pcm: NodeJS.ReadableStream, opts: StreamingOptions): Promise<BatchResult> {
    // Batch inputは BatchRunner で 16k mono PCM へ変換済み。ここでは再トランスコードせずそのまま送る。
    await waitForWhisperStreamingReady();
    const httpUrl = new URL(getWhisperStreamingHttpUrl());
    const model = getModel();
    if (opts.language) httpUrl.searchParams.set('language', opts.language);
    httpUrl.searchParams.set('task', 'transcribe');
    httpUrl.searchParams.set('model', model);

    const controller = new AbortController();
    const hardTimer = setTimeout(
      () => controller.abort(new Error('whisper_streaming batch hard timeout')),
      BATCH_HARD_TIMEOUT_MS
    );
    let idleTimer: NodeJS.Timeout | null = null;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(new Error('whisper_streaming batch idle timeout')), BATCH_IDLE_TIMEOUT_MS);
    };
    const clearIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    };
    resetIdle();
    pcm.on('data', resetIdle);
    pcm.on('end', clearIdle);
    pcm.on('close', clearIdle);

    const contentType = `audio/l16; rate=${opts.sampleRateHz}; channels=1`;
    const readable = pcm instanceof Readable ? pcm : (pcm as unknown as Readable);
    const requestInit: FetchDuplexInit = {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: Readable.toWeb(readable) as unknown as BodyInit,
      signal: controller.signal,
    };
    requestInit.duplex = 'half';

    let res: Response;
    try {
      res = await fetch(httpUrl, requestInit);
    } finally {
      clearTimeout(hardTimer);
      clearIdle();
      pcm.off('data', resetIdle);
      pcm.off('end', clearIdle);
      pcm.off('close', clearIdle);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`whisper_streaming batch failed: ${res.status} ${text || res.statusText}`);
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch (err) {
      const body = await res.text().catch(() => '');
      throw new Error(`whisper_streaming batch parse error: ${(err as Error).message}${body ? `; body=${body}` : ''}`);
    }

    const payloadRecord = typeof payload === 'object' && payload !== null ? (payload as WhisperStreamingMessage) : {};
    const words = wordsFromMessage(payloadRecord);

    const durationSecRaw =
      (typeof payloadRecord.duration === 'number' ? payloadRecord.duration : undefined) ??
      (typeof payloadRecord.durationSec === 'number' ? payloadRecord.durationSec : undefined) ??
      (typeof payloadRecord.duration_seconds === 'number' ? payloadRecord.duration_seconds : undefined) ??
      (typeof payloadRecord.duration_ms === 'number' ? payloadRecord.duration_ms / 1000 : undefined);
    const durationSec = typeof durationSecRaw === 'number' && Number.isFinite(durationSecRaw) ? durationSecRaw : undefined;

    const vendorProcessingMsRaw =
      (typeof payloadRecord.processing_ms === 'number' ? payloadRecord.processing_ms : undefined) ??
      (typeof payloadRecord.processingMs === 'number' ? payloadRecord.processingMs : undefined) ??
      (typeof payloadRecord.processing_time === 'number' ? payloadRecord.processing_time : undefined) ??
      (typeof payloadRecord.vendorProcessingMs === 'number' ? payloadRecord.vendorProcessingMs : undefined) ??
      (typeof payloadRecord.time_ms === 'number' ? payloadRecord.time_ms : undefined);
    const vendorProcessingMs =
      typeof vendorProcessingMsRaw === 'number' && Number.isFinite(vendorProcessingMsRaw)
        ? Math.round(vendorProcessingMsRaw)
        : undefined;

    const text =
      typeof payloadRecord.text === 'string'
        ? payloadRecord.text
        : typeof payloadRecord.transcription === 'string'
          ? payloadRecord.transcription
          : typeof payloadRecord.partial === 'string'
            ? payloadRecord.partial
            : '';
    return {
      provider: this.id,
      text,
      words,
      durationSec,
      vendorProcessingMs,
    };
  }
}
