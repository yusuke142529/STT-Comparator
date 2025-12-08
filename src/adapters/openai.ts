import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import type {
  BatchResult,
  PartialTranscript,
  StreamingOptions,
  StreamingSession,
  TranscriptWord,
} from '../types.js';
import { BaseAdapter } from './base.js';
import { normalizeIsoLanguageCode } from '../utils/language.js';
import { logger } from '../logger.js';

// Emit verbose OpenAI websocket diagnostics only when explicitly enabled.
const OPENAI_DEBUG = process.env.OPENAI_DEBUG === 'true';
const OPENAI_PING_INTERVAL_MS = 15_000;
const OPENAI_MANUAL_COMMIT_INTERVAL_MS = 1_000;

// Realtime transcription currently supports: whisper-1, gpt-4o-transcribe, gpt-4o-mini-transcribe.
const DEFAULT_STREAMING_MODEL = process.env.OPENAI_STREAMING_MODEL ?? 'gpt-4o-transcribe';
const DEFAULT_BATCH_MODEL = process.env.OPENAI_BATCH_MODEL ?? 'gpt-4o-transcribe';
const FALLBACK_BATCH_MODEL = process.env.OPENAI_BATCH_MODEL_FALLBACK ?? 'whisper-1';

const OPENAI_REALTIME_WS = 'wss://api.openai.com/v1/realtime';
const OPENAI_AUDIO_TRANSCRIPTION = 'https://api.openai.com/v1/audio/transcriptions';

const RESAMPLED_SAMPLE_RATE = 24_000;
const BATCH_IDLE_TIMEOUT_MS = 30_000;
const BATCH_HARD_TIMEOUT_MS = 5 * 60 * 1000;
const WS_OPEN_TIMEOUT_MS = 10_000;

function requireApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error('OpenAI API key is required. Set OPENAI_API_KEY in .env');
  }
  return key;
}

function toError(err: unknown, fallbackMessage = 'unknown error'): Error {
  if (err instanceof Error) return err;
  if (typeof err === 'string') return new Error(err);
  try {
    return new Error(JSON.stringify(err));
  } catch {
    return new Error(fallbackMessage);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rawDataToUtf8(raw: RawData): string | null {
  if (typeof raw === 'string') return raw;
  if (raw instanceof Buffer) return raw.toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return null;
}

const toTranscriptWords = (value: unknown): TranscriptWord[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((item) => {
      if (!isRecord(item)) return null;

      const text =
        typeof item.text === 'string'
          ? item.text
          : typeof item.word === 'string'
            ? item.word
            : '';

      if (!text) return null;

      const startSec =
        typeof item.start === 'number'
          ? item.start
          : typeof item.start_sec === 'number'
            ? item.start_sec
            : undefined;

      const endSec =
        typeof item.end === 'number'
          ? item.end
          : typeof item.end_sec === 'number'
            ? item.end_sec
            : undefined;

      const confidence = typeof item.confidence === 'number' ? item.confidence : undefined;

      if (startSec === undefined || endSec === undefined) {
        // If timing is absent, skip the word to avoid emitting misleading 0s.
        return null;
      }

      return {
        startSec,
        endSec,
        text,
        confidence,
      } satisfies TranscriptWord;
    })
    .filter((x): x is TranscriptWord => Boolean(x));
};

const toTranscriptWordsFromSegments = (segments: unknown): TranscriptWord[] | undefined => {
  if (!Array.isArray(segments)) return undefined;
  const words: TranscriptWord[] = [];
  for (const seg of segments) {
    if (!isRecord(seg) || !Array.isArray(seg.words)) continue;
    const segWords = toTranscriptWords(seg.words);
    if (segWords?.length) words.push(...segWords);
  }
  return words.length ? words : undefined;
};

class SampleRate24kResampler {
  private carrySample: number | null = null;
  private carryByte: number | null = null;
  private phase: number;
  private readonly step: number;
  private readonly ratio: number;
  private readonly sourceRate: number;

  constructor(sourceSampleRate: number) {
    if (!Number.isFinite(sourceSampleRate) || sourceSampleRate <= 0) {
      throw new Error(`invalid source sample rate: ${sourceSampleRate}`);
    }
    if (sourceSampleRate > RESAMPLED_SAMPLE_RATE) {
      // Downsampling without a low-pass filter would introduce aliasing; reject proactively.
      throw new Error(
        `downsampling from ${sourceSampleRate}Hz to ${RESAMPLED_SAMPLE_RATE}Hz is unsupported (would alias)`
      );
    }
    this.sourceRate = sourceSampleRate;
    this.ratio = RESAMPLED_SAMPLE_RATE / sourceSampleRate;
    this.step = sourceSampleRate / RESAMPLED_SAMPLE_RATE;
    this.phase = 0;
  }

  private alignPcm16Bytes(chunk: Buffer): Buffer {
    if (chunk.length === 0) return chunk;

    let working = chunk;

    if (this.carryByte !== null) {
      working = Buffer.concat([Buffer.from([this.carryByte]), chunk]);
      this.carryByte = null;
    }

    if (working.length % 2 === 1) {
      this.carryByte = working[working.length - 1] ?? null;
      working = working.subarray(0, working.length - 1);
    }

    return working;
  }

  resample(chunk: Buffer): Buffer {
    const aligned = this.alignPcm16Bytes(chunk);
    if (aligned.length === 0) return Buffer.alloc(0);

    if (this.sourceRate === RESAMPLED_SAMPLE_RATE) {
      return aligned;
    }

    const input = new Int16Array(
      aligned.buffer,
      aligned.byteOffset,
      Math.floor(aligned.byteLength / 2)
    );

    const paddedLength = input.length + (this.carrySample === null ? 0 : 1);
    const working = new Int16Array(paddedLength);

    let offset = 0;
    if (this.carrySample !== null) {
      working[0] = this.carrySample;
      offset = 1;
    }
    working.set(input, offset);

    const estimated = Math.ceil((working.length - this.phase) * this.ratio) + 4;
    const output = new Int16Array(estimated);

    let outIdx = 0;
    const lastValidIndex = working.length - 1;

    let pos = this.phase;
    while (pos < lastValidIndex) {
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, lastValidIndex);
      const frac = pos - i0;
      const s0 = working[i0];
      const s1 = working[i1];
      const sample = s0 + frac * (s1 - s0);
      output[outIdx++] = Math.round(sample);
      pos += this.step;
    }

    this.phase = pos - lastValidIndex;
    this.carrySample = working[lastValidIndex];

    return Buffer.from(output.buffer.slice(0, outIdx * 2));
  }
}

const getItemId = (payload: unknown): string | null =>
  isRecord(payload) && typeof payload.item_id === 'string' ? payload.item_id : null;

const extractDeltaText = (payload: unknown): string => {
  if (!isRecord(payload)) return '';
  if (typeof payload.delta === 'string') return payload.delta;
  if (isRecord(payload.delta) && typeof payload.delta.transcript === 'string') {
    return payload.delta.transcript;
  }
  if (typeof payload.text === 'string') return payload.text;
  return '';
};

const extractCompletedText = (payload: unknown): string => {
  if (!isRecord(payload)) return '';
  if (typeof payload.transcript === 'string') return payload.transcript;
  if (typeof payload.text === 'string') return payload.text;
  if (typeof payload.delta === 'string') return payload.delta;
  if (isRecord(payload.delta) && typeof payload.delta.transcript === 'string') {
    return payload.delta.transcript;
  }
  return '';
};

function toPartialTranscript(message: unknown, allowInterim: boolean): PartialTranscript | null {
  if (!isRecord(message)) return null;
  const type = typeof message.type === 'string' ? message.type : '';
  if (!type) return null;

  const now = Date.now();

  if (type === 'conversation.item.input_audio_transcription.segment') {
    if (!allowInterim) return null;
    const text = typeof message.text === 'string' ? message.text : '';
    if (!text) return null;

    const start = typeof message.start === 'number' ? message.start : undefined;
    const end = typeof message.end === 'number' ? message.end : undefined;

    const words: TranscriptWord[] | undefined =
      start !== undefined && end !== undefined
        ? [
            {
              startSec: start,
              endSec: end,
              text,
            },
          ]
        : undefined;

    return {
      provider: 'openai',
      isFinal: false,
      text,
      words,
      timestamp: now,
      channel: 'mic',
    };
  }

  // Backward-compatible fallback (some transports expose transcript/text/delta fields directly)
  const transcript =
    typeof message.transcript === 'string'
      ? message.transcript
      : typeof message.text === 'string'
        ? message.text
        : typeof message.delta === 'string'
          ? message.delta
          : undefined;

  if (!transcript) return null;

  const isFinal = type.endsWith('.completed') || type.endsWith('.complete');
  if (!allowInterim && !isFinal) return null;

  return {
    provider: 'openai',
    isFinal,
    text: transcript,
    words: undefined,
    timestamp: now,
    channel: 'mic',
  };
}

function destroyReadable(stream: NodeJS.ReadableStream, err: Error): void {
  const maybe = stream as unknown as { destroy?: (error?: Error) => void };
  if (typeof maybe.destroy === 'function') {
    try {
      maybe.destroy(err);
    } catch {
      // ignore
    }
  }
}

async function collectStream(stream: NodeJS.ReadableStream, signal?: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];

  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: unknown) => {
      if (signal?.aborted) return;
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike));
    };

    const onEnd = () => cleanupAndResolve(resolve);
    const onError = (err: unknown) => cleanupAndReject(reject, toError(err));

    const onAbort = () => {
      const reason = signal?.reason;
      const abortErr = reason instanceof Error ? reason : new Error('stream aborted');
      destroyReadable(stream, abortErr);
      cleanupAndReject(reject, abortErr);
    };

    const cleanup = () => {
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    const cleanupAndResolve = (fn: () => void) => {
      cleanup();
      fn();
    };

    const cleanupAndReject = (fn: (e: Error) => void, e: Error) => {
      cleanup();
      fn(e);
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);

    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });

  return Buffer.concat(chunks);
}

function createWavFromPcm16Mono(pcm: Buffer, sampleRate: number): Buffer {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`invalid sampleRateHz: ${sampleRate}`);
  }
  if (pcm.length % 2 === 1) {
    // drop trailing partial sample defensively
    pcm = pcm.subarray(0, pcm.length - 1);
  }

  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2; // mono, 16-bit
  const blockAlign = 2;
  const dataSize = pcm.length;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM header size
  header.writeUInt16LE(1, 20); // audio format PCM
  header.writeUInt16LE(1, 22); // channels
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}

export class OpenAIAdapter extends BaseAdapter {
  id = 'openai' as const;
  supportsStreaming = true;
  supportsBatch = true;

  async startStreaming(opts: StreamingOptions): Promise<StreamingSession> {
    const apiKey = requireApiKey();
    const model = opts.model ?? DEFAULT_STREAMING_MODEL;
    const language = normalizeIsoLanguageCode(opts.language);
    const sourceSampleRate = opts.sampleRateHz ?? 16_000;
    const allowInterim = opts.enableInterim !== false;
    const serverVadEnabled = opts.enableVad !== false;

    if (!Number.isFinite(sourceSampleRate) || sourceSampleRate <= 0) {
      throw new Error(`invalid sampleRateHz: ${sourceSampleRate}`);
    }

    // For transcription-only sessions, connect with intent=transcription and configure via `transcription_session.update`.
    const url = `${OPENAI_REALTIME_WS}?intent=transcription`;

    logger.info({
      event: 'openai_stream_start',
      model,
      language,
      sourceSampleRate,
      targetSampleRate: RESAMPLED_SAMPLE_RATE,
      schema: 'transcription_session.update',
    });

    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        // Kept for backward compatibility with environments still expecting the header.
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    const listeners: {
      data: Array<(t: PartialTranscript) => void>;
      error: Array<(err: Error) => void>;
      close: Array<() => void>;
    } = { data: [], error: [], close: [] };

    const resampler = new SampleRate24kResampler(sourceSampleRate);

    let pingTimer: NodeJS.Timeout | null = null;
    let manualCommitTimer: NodeJS.Timeout | null = null;
    const partialByItem = new Map<string, string>();

    let hasBufferedAudio = false;
    let bufferedBytes = 0;

    const clearManualCommitTimer = () => {
      if (manualCommitTimer) {
        clearTimeout(manualCommitTimer);
        manualCommitTimer = null;
      }
    };

    const resetBufferedState = () => {
      hasBufferedAudio = false;
      bufferedBytes = 0;
      clearManualCommitTimer();
    };

    const minBufferedMs = 100;
    const minBufferedBytes = Math.ceil((RESAMPLED_SAMPLE_RATE * 2 * minBufferedMs) / 1000); // mono 16-bit

    const wsReady = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        reject(new Error('openai realtime connection timeout'));
      }, WS_OPEN_TIMEOUT_MS);

      ws.once('open', () => {
        clearTimeout(timer);

        const session = {
          input_audio_format: 'pcm16' as const, // 24k mono PCM @ 16-bit
          input_audio_noise_reduction: { type: 'near_field' as const },
          input_audio_transcription: {
            model,
            language: language ?? '',
            prompt: opts.dictionaryPhrases?.join(', ') ?? '',
          },
          turn_detection: serverVadEnabled
            ? {
                type: 'server_vad',
                silence_duration_ms: 500,
                prefix_padding_ms: 300,
                threshold: 0.5,
              }
            : null,
        };

        ws.send(
          JSON.stringify({
            type: 'transcription_session.update',
            session,
          })
        );

        resolve();
      });

      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(toError(err, 'openai realtime socket error'));
      });

      ws.once('close', () => {
        clearTimeout(timer);
        reject(new Error('openai realtime socket closed before ready'));
      });
    });

    const commitBuffer = async (force = false) => {
      if (!hasBufferedAudio) return;
      if (!force && bufferedBytes < minBufferedBytes) return;

      await wsReady;

      if (ws.readyState !== WebSocket.OPEN) return;

      ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      resetBufferedState();
    };

    const scheduleManualCommit = () => {
      // When server-side VAD is on, OpenAI will commit; avoid double-commits that race with VAD.
      if (serverVadEnabled) return;
      if (manualCommitTimer) return;
      manualCommitTimer = setTimeout(() => {
        manualCommitTimer = null;
        void commitBuffer().catch((err) => listeners.error.forEach((cb) => cb(toError(err))));
      }, OPENAI_MANUAL_COMMIT_INTERVAL_MS);
    };

    ws.on('message', (raw: RawData) => {
      const text = rawDataToUtf8(raw);
      if (!text) return;

      try {
        const payload = JSON.parse(text) as unknown;

        if (OPENAI_DEBUG) {
          const t =
            isRecord(payload) && typeof payload.type === 'string' ? payload.type : 'unknown_event';
          logger.debug({ event: 'openai_ws_message', type: t, snippet: text.slice(0, 800) });
        }

        // Prefer cumulative assembly for OpenAI deltas so UI sees growing text instead of tokens.
        if (isRecord(payload) && typeof payload.type === 'string') {
          const itemId = getItemId(payload) ?? 'default';

          if (payload.type === 'conversation.item.input_audio_transcription.delta') {
            if (allowInterim) {
              const deltaText = extractDeltaText(payload);
              if (deltaText) {
                const next = (partialByItem.get(itemId) ?? '') + deltaText;
                partialByItem.set(itemId, next);
                listeners.data.forEach((cb) =>
                  cb({
                    provider: 'openai',
                    isFinal: false,
                    text: next,
                    words: undefined,
                    timestamp: Date.now(),
                    channel: 'mic',
                  })
                );
              }
            }
            return;
          }

          if (payload.type === 'conversation.item.input_audio_transcription.completed') {
            const finalText = extractCompletedText(payload);
            if (finalText) {
              partialByItem.delete(itemId);
              listeners.data.forEach((cb) =>
                cb({
                  provider: 'openai',
                  isFinal: true,
                  text: finalText,
                  words: undefined,
                  timestamp: Date.now(),
                  channel: 'mic',
                })
              );
            }
            return;
          }

          if (payload.type === 'conversation.item.input_audio_transcription.failed') {
            partialByItem.delete(itemId);
          }

          if (payload.type === 'conversation.item.deleted') {
            partialByItem.delete(itemId);
          }
        }

        // Server confirms commits (client- or server-VAD-initiated). Align local buffer tracking.
        if (isRecord(payload) && payload.type === 'input_audio_buffer.committed') {
          resetBufferedState();
          return;
        }
        if (isRecord(payload) && payload.type === 'input_audio_buffer.cleared') {
          resetBufferedState();
          return;
        }

        // Transcription failures are item-scoped.
        if (isRecord(payload) && payload.type === 'conversation.item.input_audio_transcription.failed') {
          const errObj = isRecord(payload.error) ? payload.error : null;
          const msg = errObj && typeof errObj.message === 'string' ? errObj.message : 'openai transcription failed';
          listeners.error.forEach((cb) => cb(new Error(msg)));
          return;
        }

        const transcript = toPartialTranscript(payload, allowInterim);
        if (transcript) {
          listeners.data.forEach((cb) => cb(transcript));
          return;
        }

        // Generic error event
        if (isRecord(payload) && payload.type === 'error' && isRecord(payload.error)) {
          const message =
            typeof payload.error.message === 'string' ? payload.error.message : 'openai realtime error';
          const errSnippet = text.slice(0, 800);
          logger.warn({ event: 'openai_ws_api_error', message, snippet: errSnippet });

          if (message.toLowerCase().includes('buffer too small')) {
            // Benign: can happen when server VAD committed while client also commits.
            resetBufferedState();
            return;
          }
          listeners.error.forEach((cb) => cb(new Error(message)));
        }
      } catch (err) {
        listeners.error.forEach((cb) => cb(toError(err)));
      }
    });

    ws.on('error', (err) => {
      logger.error({ event: 'openai_ws_error', message: err.message });
      listeners.error.forEach((cb) => cb(toError(err)));
    });

    ws.on('close', (code, reason) => {
      if (pingTimer) clearInterval(pingTimer);
      const reasonText = reason?.toString() ?? '';
      logger.info({ event: 'openai_ws_close', code, reason: reasonText });

      const isNormalClose = code === 1000 || code === 1005;
      if (!isNormalClose || reasonText.length > 0) {
        const message =
          reasonText.length > 0
            ? `openai realtime socket closed: ${code ?? 'unknown'} ${reasonText}`
            : `openai realtime socket closed: ${code ?? 'unknown'}`;
        logger.warn({ event: 'openai_ws_close_diagnostic', code, reason: reasonText });
        listeners.error.forEach((cb) => cb(new Error(message)));
      }

      clearManualCommitTimer();
      listeners.close.forEach((cb) => cb());
    });

    const controller = {
      async sendAudio(chunk: ArrayBufferLike, _meta?: { captureTs?: number }) {
        await wsReady;
        if (ws.readyState !== WebSocket.OPEN) {
          throw new Error('openai realtime socket is not open');
        }

        const pcm = Buffer.from(chunk);
        const resampled = resampler.resample(pcm);
        if (resampled.length === 0) return;

        hasBufferedAudio = true;
        bufferedBytes += resampled.length;

        ws.send(
          JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: resampled.toString('base64'),
          })
        );

        scheduleManualCommit();
      },

      async end() {
        clearManualCommitTimer();
        await commitBuffer(true);
      },

      async close() {
        clearManualCommitTimer();
        if (hasBufferedAudio) {
          await commitBuffer(true).catch(() => {
            // ignore commit errors during shutdown
          });
        }
        try {
          ws.close();
        } catch {
          // ignore
        }
      },
    };

    // keepalive to prevent idle timeouts on long recordings
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
        } catch (err) {
          if (OPENAI_DEBUG) logger.debug({ event: 'openai_ws_ping_error', err: String(err) });
        }
      }
    }, OPENAI_PING_INTERVAL_MS);

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
    const primaryModel = opts.batchModel ?? opts.model ?? DEFAULT_BATCH_MODEL;
    const fallbackModel = opts.fallbackModel ?? FALLBACK_BATCH_MODEL;
    const language = normalizeIsoLanguageCode(opts.language);

    const sampleRateHz = opts.sampleRateHz ?? 16_000;
    if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) {
      throw new Error(`invalid sampleRateHz: ${sampleRateHz}`);
    }

    const controller = new AbortController();

    let aborted = false;
    const abortWith = (reason: Error) => {
      if (aborted) return;
      aborted = true;
      controller.abort(reason);
      destroyReadable(pcm, reason);
    };

    const hardTimer = setTimeout(() => abortWith(new Error('openai batch hard timeout')), BATCH_HARD_TIMEOUT_MS);

    let idleTimer: NodeJS.Timeout | null = null;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => abortWith(new Error('openai batch idle timeout')), BATCH_IDLE_TIMEOUT_MS);
    };
    const clearIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    };

    pcm.on('data', resetIdle);
    pcm.on('end', clearIdle);
    pcm.on('close', clearIdle);
    resetIdle();

    try {
      const audioBuf = await collectStream(pcm, controller.signal);
      clearIdle();

      const wav = createWavFromPcm16Mono(audioBuf, sampleRateHz);

      const buildForm = (useModel: string) => {
        const form = new FormData();
        form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
        form.append('model', useModel);
        if (language) form.append('language', language);
        if (opts.dictionaryPhrases?.length) form.append('prompt', opts.dictionaryPhrases.join(', '));
        form.append('chunking_strategy', 'auto');

        // Word timestamps require verbose_json, which is not supported by gpt-4o-transcribe / gpt-4o-mini-transcribe.
        if (useModel === 'whisper-1') {
          form.append('response_format', 'verbose_json');
          form.append('timestamp_granularities[]', 'word');
        } else {
          form.append('response_format', 'json');
        }

        return form;
      };

      const callTranscribe = async (useModel: string) => {
        const res = await fetch(OPENAI_AUDIO_TRANSCRIPTION, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
          body: buildForm(useModel),
          signal: controller.signal,
        });
        return res;
      };

      let res = await callTranscribe(primaryModel);

      if (!res.ok && fallbackModel && fallbackModel !== primaryModel) {
        const text = await res.text().catch(() => '');
        if (OPENAI_DEBUG) {
          logger.warn({
            event: 'openai_batch_primary_failed',
            status: res.status,
            statusText: res.statusText,
            body: text.slice(0, 800),
          });
        }
        res = await callTranscribe(fallbackModel);
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`openai batch failed: ${res.status} ${text || res.statusText}`);
      }

      const payload = (await res.json()) as unknown;
      const rec = isRecord(payload) ? payload : {};
      const words = toTranscriptWords(rec.words) ?? toTranscriptWordsFromSegments(rec.segments);
      const text =
        typeof rec.text === 'string'
          ? rec.text
          : typeof rec.transcript === 'string'
            ? rec.transcript
            : '';

      return {
        provider: this.id,
        text,
        words,
      };
    } finally {
      clearTimeout(hardTimer);
      clearIdle();
      pcm.off('data', resetIdle);
      pcm.off('end', clearIdle);
      pcm.off('close', clearIdle);
    }
  }
}
