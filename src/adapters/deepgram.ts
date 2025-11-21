import { Readable } from 'node:stream';
import { WebSocket } from 'ws';
import type { BatchResult, PartialTranscript, StreamingOptions, StreamingSession } from '../types.js';
import { BaseAdapter } from './base.js';

const DEEPGRAM_WS = 'wss://api.deepgram.com/v1/listen';
const DEEPGRAM_HTTP = 'https://api.deepgram.com/v1/listen';

function requireApiKey(): string {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) {
    throw new Error('Deepgram API key is required. Set DEEPGRAM_API_KEY in .env');
  }
  return key;
}

export class DeepgramAdapter extends BaseAdapter {
  id = 'deepgram' as const;
  supportsStreaming = true;
  supportsBatch = true;

  async startStreaming(opts: StreamingOptions): Promise<StreamingSession> {
    const apiKey = requireApiKey();
    const query = new URLSearchParams({
      encoding: opts.encoding,
      sample_rate: String(opts.sampleRateHz),
      language: opts.language,
      punctuate: opts.punctuationPolicy === 'none' ? 'false' : 'true',
    });
    if (opts.enableInterim === false) {
      query.set('interim_results', 'false');
    }
    if (opts.dictionaryPhrases && opts.dictionaryPhrases.length > 0) {
      query.set('keywords', opts.dictionaryPhrases.join(','));
    }
    const ws = new WebSocket(`${DEEPGRAM_WS}?${query.toString()}`, {
      headers: { Authorization: `Token ${apiKey}` },
    });

    const wsReady = new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
      ws.once('close', () => reject(new Error('WebSocket closed before open')));
    });

    const listeners: {
      data: ((t: PartialTranscript) => void)[];
      error: ((err: Error) => void)[];
      close: (() => void)[];
    } = { data: [], error: [], close: [] };

    ws.on('message', (data) => {
      try {
        const json = JSON.parse(data.toString());
        if (json.type === 'Results' && json.channel?.alternatives?.length) {
          const alt = json.channel.alternatives[0];
          const isFinal = Boolean(json.is_final);
          const transcript: PartialTranscript = {
            provider: this.id,
            isFinal,
            text: alt.transcript ?? '',
            words: alt.words?.map((w: any) => ({
              startSec: w.start ?? 0,
              endSec: w.end ?? 0,
              text: w.word ?? '',
              confidence: w.confidence,
            })),
            timestamp: Date.now(),
            channel: 'mic',
          };
          listeners.data.forEach((cb) => cb(transcript));
        } else if (json.type === 'Error') {
          const err = new Error(json.message ?? 'Deepgram error');
          listeners.error.forEach((cb) => cb(err));
        }
      } catch (error) {
        listeners.error.forEach((cb) => cb(error as Error));
      }
    });

    ws.on('error', (err) => {
      listeners.error.forEach((cb) => cb(err as Error));
    });

    ws.on('close', () => {
      listeners.close.forEach((cb) => cb());
    });

    const controller = {
      async sendAudio(chunk: ArrayBufferLike) {
        await wsReady;
        ws.send(Buffer.from(chunk));
      },
      async end() {
        ws.close();
      },
      async close() {
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
    const apiKey = requireApiKey();
    const query = new URLSearchParams({
      language: opts.language,
      punctuate: opts.punctuationPolicy === 'none' ? 'false' : 'true',
    });
    if (opts.dictionaryPhrases && opts.dictionaryPhrases.length > 0) {
      query.set('keywords', opts.dictionaryPhrases.join(','));
    }
    const contentType = `audio/l16; rate=${opts.sampleRateHz}; channels=1`;

    const controller = new AbortController();
    const hardTimeout = setTimeout(() => controller.abort(new Error('Deepgram batch hard timeout')), 5 * 60 * 1000); // 5m cap
    const idleTimeoutMs = 30_000;
    let idleTimer: NodeJS.Timeout | null = null;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(new Error('Deepgram batch idle timeout')), idleTimeoutMs);
    };
    resetIdle();

    const readable = pcm as Readable;
    readable.on('readable', resetIdle);

    const requestInit: RequestInit = {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': contentType,
      },
      body: Readable.toWeb(readable) as unknown as BodyInit,
      signal: controller.signal,
    };
    // Node fetch requires duplex for streamed request bodies
    (requestInit as any).duplex = 'half';

    const res = await fetch(`${DEEPGRAM_HTTP}?${query.toString()}`, requestInit);

    clearTimeout(hardTimeout);
    if (idleTimer) clearTimeout(idleTimer);
    readable.off('readable', resetIdle);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Deepgram batch failed: ${res.status} ${text}`);
    }
    const json: any = await res.json();
    const alt = json.results?.channels?.[0]?.alternatives?.[0];
    const durationSec = json.metadata?.duration ?? alt?.duration ?? 0;
    const vendorProcessingMs = Math.round(
      (json.metadata?.processing_ms as number | undefined) ??
        (json.metadata?.processing_time as number | undefined) ??
        0
    );
    return {
      provider: this.id,
      text: alt?.transcript ?? '',
      words: alt?.words?.map((w: any) => ({
        startSec: w.start ?? 0,
        endSec: w.end ?? 0,
        text: w.word ?? '',
        confidence: w.confidence,
      })),
      durationSec,
      vendorProcessingMs: Number.isFinite(vendorProcessingMs) ? vendorProcessingMs : undefined,
    };
  }
}
