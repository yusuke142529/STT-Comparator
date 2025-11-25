import { Readable } from 'node:stream';
import { WebSocket } from 'ws';
import type { BatchResult, PartialTranscript, StreamingOptions, StreamingSession } from '../types.js';
import { BaseAdapter } from './base.js';
import {
  getWhisperStreamingHttpUrl,
  getWhisperStreamingReadyIntervalMs,
  getWhisperStreamingReadyTimeoutMs,
  getWhisperStreamingReadyUrl,
  getWhisperStreamingWsUrl,
} from '../utils/whisperStreamingConfig.js';

const DEFAULT_MODEL = 'small';
const WS_OPEN_TIMEOUT_MS = 10_000;
const WS_IDLE_SEND_TIMEOUT_MS = 10_000;
const BATCH_HARD_TIMEOUT_MS = 5 * 60 * 1000; // 5m
const BATCH_IDLE_TIMEOUT_MS = 30_000;
async function waitForWhisperStreamingReady(): Promise<void> {
  if (process.env.NODE_ENV === 'test') {
    return;
  }
  const timeoutMs = getWhisperStreamingReadyTimeoutMs();
  if (timeoutMs <= 0) {
    return;
  }
  const readyUrl = getWhisperStreamingReadyUrl();
  const intervalMs = getWhisperStreamingReadyIntervalMs();
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | null = null;

  while (Date.now() <= deadline) {
    try {
      await fetch(readyUrl, { method: 'GET', cache: 'no-store' });
      return;
    } catch (error) {
      lastError = error as Error;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      await delay(Math.min(intervalMs, remainingMs));
    }
  }

  const baseMessage = `whisper_streaming health check timed out after ${timeoutMs}ms`;
  if (lastError) {
    throw new Error(`${baseMessage}: ${lastError.message}`);
  }
  throw new Error(baseMessage);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getModel(): string {
  return process.env.WHISPER_MODEL ?? DEFAULT_MODEL;
}

function toPartialTranscript(message: any): PartialTranscript | null {
  if (!message || typeof message !== 'object') return null;

  const text =
    message.text ??
    message.partial ??
    message.transcript ??
    message.transcription ??
    message.result ??
    '';

  const isFinal =
    Boolean(message.is_final ?? message.isFinal ?? message.final ?? message.done ?? message.complete) ||
    message.type === 'final' ||
    message.type === 'completed';

  const wordsSource = Array.isArray(message.words)
    ? message.words
    : Array.isArray(message.segments)
      ? message.segments.flatMap((seg: any) => seg?.words ?? [])
      : undefined;

  const words =
    wordsSource?.map((w: any) => ({
      startSec: Number(w.start ?? w.startSec ?? w.t0 ?? w.from ?? 0),
      endSec: Number(w.end ?? w.endSec ?? w.t1 ?? w.to ?? 0),
      text: String(w.word ?? w.text ?? '').trim(),
      confidence:
        typeof w.confidence === 'number'
          ? w.confidence
          : typeof w.probability === 'number'
            ? w.probability
            : undefined,
    })) ?? undefined;

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
      async sendAudio(chunk: ArrayBufferLike) {
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
    const requestInit: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: Readable.toWeb(pcm) as unknown as BodyInit,
      signal: controller.signal,
    };
    (requestInit as any).duplex = 'half';

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

    let payload: any;
    try {
      payload = await res.json();
    } catch (err) {
      const body = await res.text().catch(() => '');
      throw new Error(`whisper_streaming batch parse error: ${(err as Error).message}${body ? `; body=${body}` : ''}`);
    }

    const words =
      (Array.isArray(payload.words)
        ? payload.words
        : Array.isArray(payload.segments)
          ? payload.segments.flatMap((seg: any) => seg?.words ?? [])
          : undefined
      )?.map((w: any) => ({
        startSec: Number(w.start ?? w.startSec ?? w.t0 ?? 0),
        endSec: Number(w.end ?? w.endSec ?? w.t1 ?? 0),
        text: String(w.word ?? w.text ?? '').trim(),
        confidence:
          typeof w.confidence === 'number'
            ? w.confidence
            : typeof w.probability === 'number'
              ? w.probability
              : undefined,
      }));

    const durationSecRaw =
      payload.duration ??
      payload.durationSec ??
      payload.duration_seconds ??
      (typeof payload.duration_ms === 'number' ? payload.duration_ms / 1000 : undefined);
    const durationSec = typeof durationSecRaw === 'number' && Number.isFinite(durationSecRaw) ? durationSecRaw : undefined;

    const vendorProcessingMsRaw =
      payload.processing_ms ??
      payload.processingMs ??
      payload.processing_time ??
      payload.vendorProcessingMs ??
      payload.time_ms;
    const vendorProcessingMs =
      typeof vendorProcessingMsRaw === 'number' && Number.isFinite(vendorProcessingMsRaw)
        ? Math.round(vendorProcessingMsRaw)
        : undefined;

    return {
      provider: this.id,
      text: typeof payload.text === 'string' ? payload.text : typeof payload.transcription === 'string' ? payload.transcription : '',
      words,
      durationSec: durationSec,
      vendorProcessingMs,
    };
  }
}
