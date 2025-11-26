import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { WebSocket } from 'ws';
import type {
  BatchResult,
  PartialTranscript,
  StreamingOptions,
  StreamingSession,
  TranscriptWord,
} from '../types.js';
import { BaseAdapter } from './base.js';
import { normalizeIsoLanguageCode } from '../utils/language.js';

const STREAMING_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
const STREAMING_MODEL_ID = 'scribe_v2_realtime';
const BATCH_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
const BATCH_MODEL_ID = 'scribe_v1';
const INCLUDE_TIMESTAMPED_COMMITS = true;
const DEFAULT_BATCH_TIMEOUT_MS = 60_000;

const ELEVENLABS_BATCH_MAX_ATTEMPTS = (() => {
  const envValue = Number(process.env.ELEVENLABS_BATCH_MAX_ATTEMPTS);
  if (Number.isFinite(envValue) && envValue >= 1) {
    return envValue;
  }
  return 3;
})();

const ELEVENLABS_BATCH_BASE_DELAY_MS = (() => {
  const envValue = Number(process.env.ELEVENLABS_BATCH_BASE_DELAY_MS);
  if (Number.isFinite(envValue) && envValue > 0) {
    return envValue;
  }
  return 1000;
})();

const ELEVENLABS_BATCH_MAX_DELAY_MS = (() => {
  const envValue = Number(process.env.ELEVENLABS_BATCH_MAX_DELAY_MS);
  if (Number.isFinite(envValue) && envValue > 0) {
    return envValue;
  }
  return 5000;
})();

const ELEVENLABS_BATCH_TIMEOUT_MS = (() => {
  const envValue = Number(process.env.ELEVENLABS_BATCH_TIMEOUT_MS);
  if (Number.isFinite(envValue) && envValue > 0) {
    return envValue;
  }
  return DEFAULT_BATCH_TIMEOUT_MS;
})();

const AUDIO_FORMATS: Record<number, string> = {
  8000: 'pcm_8000',
  16000: 'pcm_16000',
  22050: 'pcm_22050',
  24000: 'pcm_24000',
  44100: 'pcm_44100',
  48000: 'pcm_48000',
};

const ELEVENLABS_BATCH_RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

interface ElevenLabsStreamingEvent {
  message_type?: string;
  text?: string;
  words?: unknown[];
  message?: string;
}

interface ElevenLabsBatchResponse {
  text?: string;
  words?: unknown[];
  duration_seconds?: number;
  processing_time?: number;
  processing_time_ms?: number;
  metadata?: {
    duration_seconds?: number;
    duration?: number;
    processing_time?: number;
    processing_time_ms?: number;
  };
}

function requireApiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    throw new Error('ElevenLabs API key is required. Set ELEVENLABS_API_KEY in .env');
  }
  return key;
}

function getAudioFormat(sampleRate: number): string {
  const format = AUDIO_FORMATS[sampleRate];
  if (format) return format;
  return 'pcm_16000';
}

async function collectStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.once('end', resolve);
    stream.once('error', reject);
  });
  return Buffer.concat(chunks);
}

function buildMultipartBody(
  fields: Record<string, string>,
  fileName: string,
  fileBuffer: Buffer,
  fileContentType: string
): { body: Buffer; contentType: string } {
  const boundary = `----elevenlabs-${randomUUID()}`;
  const parts: Buffer[] = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`)
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${fileContentType}\r\n\r\n`
    )
  );
  parts.push(fileBuffer);
  parts.push(Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function normalizeWords(items: unknown[] | undefined): TranscriptWord[] | undefined {
  if (!items?.length) return undefined;
  const mapped: TranscriptWord[] = [];
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const text = typeof entry.text === 'string' ? entry.text : typeof entry.word === 'string' ? entry.word : '';
    const trimmed = text.trim();
    if (!trimmed) continue;
    const start =
      typeof entry.start_time === 'number'
        ? entry.start_time
        : typeof entry.start === 'number'
        ? entry.start
        : undefined;
    const end =
      typeof entry.end_time === 'number'
        ? entry.end_time
        : typeof entry.end === 'number'
        ? entry.end
        : undefined;
    if (typeof start !== 'number' || Number.isNaN(start)) continue;
    const transcriptWord: TranscriptWord = {
      startSec: start,
      endSec: typeof end === 'number' && !Number.isNaN(end) ? end : start,
      text: trimmed,
    };
    if (typeof entry.confidence === 'number') {
      transcriptWord.confidence = entry.confidence;
    }
    mapped.push(transcriptWord);
  }
  return mapped.length > 0 ? mapped : undefined;
}

function shouldRetryElevenLabsStatus(status: number): boolean {
  return ELEVENLABS_BATCH_RETRYABLE_STATUS.has(status) || (status >= 500 && status < 600);
}

function shouldRetryElevenLabsError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const text = error.message.toLowerCase();
  return (
    error.name === 'AbortError' ||
    text.includes('timeout') ||
    text.includes('failed to fetch') ||
    text.includes('network')
  );
}

function delayWithJitter(attempt: number): Promise<void> {
  const baseDelay = Math.min(
    ELEVENLABS_BATCH_BASE_DELAY_MS * 2 ** (attempt - 1),
    ELEVENLABS_BATCH_MAX_DELAY_MS
  );
  const jitter = Math.floor(Math.random() * 250);
  return new Promise((resolve) => setTimeout(resolve, baseDelay + jitter));
}

export class ElevenLabsAdapter extends BaseAdapter {
  id = 'elevenlabs' as const;
  supportsStreaming = true;
  supportsBatch = true;

  async startStreaming(opts: StreamingOptions): Promise<StreamingSession> {
    const apiKey = requireApiKey();
    const audioFormat = getAudioFormat(opts.sampleRateHz);
    const commitStrategy = opts.enableVad ? 'vad' : 'manual';
    const params = new URLSearchParams({
      model_id: STREAMING_MODEL_ID,
      audio_format: audioFormat,
      commit_strategy: commitStrategy,
      include_timestamps: INCLUDE_TIMESTAMPED_COMMITS ? 'true' : 'false',
    });
    const allowInterim = opts.enableInterim !== false;
    const normalizedLanguage = normalizeIsoLanguageCode(opts.language);
    if (normalizedLanguage) {
      params.set('language_code', normalizedLanguage);
    }
    const ws = new WebSocket(`${STREAMING_URL}?${params.toString()}`, {
      headers: { 'xi-api-key': apiKey },
    });

    const ready = new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
      ws.once('close', () => reject(new Error('WebSocket closed before open')));
    });

    const listeners = {
      data: [] as ((t: PartialTranscript) => void)[],
      error: [] as ((err: Error) => void)[],
      close: [] as (() => void)[],
    };
    const manualCommit = commitStrategy === 'manual';
    let committed = !manualCommit;
    let closed = false;

    const emitTranscript = (data: ElevenLabsStreamingEvent, isFinal: boolean, words?: TranscriptWord[]) => {
      const text = typeof data.text === 'string' ? data.text : '';
      const payload: PartialTranscript = {
        provider: this.id,
        isFinal,
        text,
        words,
        timestamp: Date.now(),
        channel: 'mic',
      };
      listeners.data.forEach((cb) => cb(payload));
    };

    const handleError = (message: string) => {
      const err = new Error(message);
      listeners.error.forEach((cb) => cb(err));
    };

    const parseMessage = (raw: Buffer) => {
      try {
        const json = JSON.parse(raw.toString()) as ElevenLabsStreamingEvent;
        const type = json.message_type;
        if (!type) {
          return;
        }
        if (type === 'partial_transcript') {
          if (allowInterim) {
            emitTranscript(json, false);
          }
          return;
        }
        if (type === 'committed_transcript') {
          if (INCLUDE_TIMESTAMPED_COMMITS) {
            return;
          }
          emitTranscript(json, true);
          return;
        }
        if (type === 'committed_transcript_with_timestamps') {
          emitTranscript(json, true, normalizeWords(json.words));
          return;
        }
        if (
          type === 'scribe_error' ||
          type === 'scribe_auth_error' ||
          type === 'scribe_quota_exceeded_error' ||
          type === 'auth_error' ||
          type === 'quota_exceeded' ||
          type === 'error' ||
          type === 'transcriber_error' ||
          type === 'input_error'
        ) {
          handleError(json.message ?? `ElevenLabs stream error (${type})`);
        }
      } catch (err) {
        listeners.error.forEach((cb) => cb(err as Error));
      }
    };

    ws.on('message', (data) => {
      if (Buffer.isBuffer(data)) {
        parseMessage(data);
        return;
      }
      if (typeof data === 'string') {
        parseMessage(Buffer.from(data));
        return;
      }
      if (Array.isArray(data)) {
        parseMessage(Buffer.concat(data));
      }
    });

    ws.on('error', (err) => {
      listeners.error.forEach((cb) => cb(err));
    });
    ws.on('close', () => {
      if (closed) {
        return;
      }
      closed = true;
      listeners.close.forEach((cb) => cb());
    });

    const sendMessage = async (payload: Record<string, unknown>) => {
      await ready;
      if (ws.readyState !== WebSocket.OPEN) {
        throw new Error('ElevenLabs WebSocket is not open');
      }
      ws.send(JSON.stringify(payload));
    };

    const ensureCommit = async () => {
      if (committed) return;
      committed = true;
      await sendMessage({
        message_type: 'input_audio_chunk',
        audio_base_64: '',
        commit: true,
        sample_rate: opts.sampleRateHz,
      });
    };

    const controller = {
      async sendAudio(chunk: ArrayBufferLike) {
        const audioBuffer = Buffer.from(chunk);
        await sendMessage({
          message_type: 'input_audio_chunk',
          audio_base_64: audioBuffer.toString('base64'),
          sample_rate: opts.sampleRateHz,
        });
      },
      async end() {
        await ensureCommit();
      },
      async close() {
        await ensureCommit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      },
    };

    return {
      controller,
      onData(cb: (t: PartialTranscript) => void) {
        listeners.data.push(cb);
      },
      onError(cb: (err: Error) => void) {
        listeners.error.push(cb);
      },
      onClose(cb: () => void) {
        listeners.close.push(cb);
      },
    };
  }

  async transcribeFileFromPCM(pcm: NodeJS.ReadableStream, opts: StreamingOptions): Promise<BatchResult> {
    const buffer = await collectStream(pcm);
    if ('destroy' in pcm && typeof (pcm as Readable).destroy === 'function') {
      (pcm as Readable).destroy();
    }
    const apiKey = requireApiKey();
    const fields: Record<string, string> = { model_id: BATCH_MODEL_ID };
    const normalizedLanguage = normalizeIsoLanguageCode(opts.language);
    if (normalizedLanguage) {
      fields.language_code = normalizedLanguage;
    }
    const fileContentType = `audio/l16; rate=${opts.sampleRateHz}; channels=1`;
    const { body, contentType } = buildMultipartBody(fields, 'audio.pcm', buffer, fileContentType);
    const json = await this.sendBatchWithRetry(body, contentType, apiKey);
    const words = normalizeWords(json.words);
    return {
      provider: this.id,
      text: typeof json.text === 'string' ? json.text : '',
      words,
      durationSec: this.deriveDuration(words, json),
      vendorProcessingMs: this.extractProcessingTime(json),
    };
  }

  private async sendBatchWithRetry(body: Buffer, contentType: string, apiKey: string): Promise<ElevenLabsBatchResponse> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= ELEVENLABS_BATCH_MAX_ATTEMPTS; attempt += 1) {
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), ELEVENLABS_BATCH_TIMEOUT_MS);
      try {
        const response = await fetch(BATCH_URL, {
          method: 'POST',
          headers: {
            'xi-api-key': apiKey,
            'Content-Type': contentType,
            'Content-Length': String(body.length),
          },
          body,
          signal: abortController.signal,
        });
        if (!response.ok) {
          const text = await response.text().catch(() => 'no details');
          const error = new Error(`ElevenLabs batch failed: ${response.status} ${text}`);
          if (!shouldRetryElevenLabsStatus(response.status) || attempt === ELEVENLABS_BATCH_MAX_ATTEMPTS) {
            throw error;
          }
          lastError = error;
          await delayWithJitter(attempt);
          continue;
        }
        const json = (await response.json()) as ElevenLabsBatchResponse;
        return json;
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          const timeoutError = new Error(`ElevenLabs batch request timed out after ${ELEVENLABS_BATCH_TIMEOUT_MS}ms`);
          if (attempt === ELEVENLABS_BATCH_MAX_ATTEMPTS) {
            throw timeoutError;
          }
          lastError = timeoutError;
        } else if (attempt === ELEVENLABS_BATCH_MAX_ATTEMPTS || !shouldRetryElevenLabsError(err)) {
          throw err instanceof Error ? err : new Error('ElevenLabs batch failed');
        } else {
          lastError = err instanceof Error ? err : new Error('ElevenLabs batch failed');
        }
        await delayWithJitter(attempt);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError ?? new Error('ElevenLabs batch failed');
  }

  private deriveDuration(words: TranscriptWord[] | undefined, json: ElevenLabsBatchResponse): number | undefined {
    const durationSource =
      typeof json.duration_seconds === 'number' && Number.isFinite(json.duration_seconds)
        ? json.duration_seconds
        : typeof json.metadata?.duration_seconds === 'number' && Number.isFinite(json.metadata.duration_seconds)
        ? json.metadata.duration_seconds
        : typeof json.metadata?.duration === 'number' && Number.isFinite(json.metadata.duration)
        ? json.metadata.duration
        : undefined;
    if (typeof durationSource === 'number') {
      return durationSource;
    }
    if (words?.length) {
      return words[words.length - 1].endSec;
    }
    return undefined;
  }

  private extractProcessingTime(json: ElevenLabsBatchResponse): number | undefined {
    const processing =
      (typeof json.processing_time === 'number' && Number.isFinite(json.processing_time)
        ? json.processing_time
        : typeof json.processing_time_ms === 'number' && Number.isFinite(json.processing_time_ms)
        ? json.processing_time_ms
        : undefined) ??
      (typeof json.metadata?.processing_time === 'number' && Number.isFinite(json.metadata.processing_time)
        ? json.metadata.processing_time
        : typeof json.metadata?.processing_time_ms === 'number' && Number.isFinite(json.metadata.processing_time_ms)
        ? json.metadata.processing_time_ms
        : undefined);
    if (typeof processing === 'number') {
      return Math.round(processing);
    }
    return undefined;
  }
}
