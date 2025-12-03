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

const OPENAI_DEBUG = process.env.OPENAI_DEBUG === '1';
const OPENAI_PING_INTERVAL_MS = 15_000;
const OPENAI_MANUAL_COMMIT_INTERVAL_MS = 1_000;

// Use latest STT-capable models by default; can be overridden via env.
// Realtime transcription currently supports: whisper-1, gpt-4o-transcribe, gpt-4o-mini-transcribe.
// Use gpt-4o-transcribe by default; env can override.
const DEFAULT_STREAMING_MODEL = process.env.OPENAI_STREAMING_MODEL ?? 'gpt-4o-transcribe';
// Prefer newest high-accuracy model; allow override via env.
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

const toTranscriptWords = (value: unknown): TranscriptWord[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const word = item as Record<string, unknown>;
      const text = typeof word.text === 'string' ? word.text : typeof word.word === 'string' ? word.word : '';
      if (!text) return null;
      const startSec = typeof word.start === 'number' ? word.start : typeof word.start_sec === 'number' ? word.start_sec : undefined;
      const endSec = typeof word.end === 'number' ? word.end : typeof word.end_sec === 'number' ? word.end_sec : undefined;
      const confidence = typeof word.confidence === 'number' ? word.confidence : undefined;
      return {
        startSec: startSec ?? 0,
        endSec: endSec ?? startSec ?? 0,
        text,
        confidence,
      } satisfies TranscriptWord;
    })
    .filter((x): x is TranscriptWord => Boolean(x));
};

class SampleRate24kResampler {
  private carrySample: number | null = null;
  private phase: number;
  private readonly step: number;
  private readonly ratio: number;
  private readonly sourceRate: number;

  constructor(sourceSampleRate: number) {
    this.sourceRate = sourceSampleRate;
    this.ratio = RESAMPLED_SAMPLE_RATE / sourceSampleRate;
    this.step = sourceSampleRate / RESAMPLED_SAMPLE_RATE;
    this.phase = 0;
  }

  resample(chunk: Buffer): Buffer {
    if (chunk.length === 0) return Buffer.alloc(0);
    if (
      this.sourceRate === RESAMPLED_SAMPLE_RATE ||
      !Number.isFinite(this.sourceRate) ||
      this.sourceRate <= 0
    ) {
      return chunk;
    }

    const input = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2);
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

function toPartialTranscript(message: unknown): PartialTranscript | null {
  if (!message || typeof message !== 'object') return null;
  const payload = message as Record<string, unknown>;
  const type = typeof payload.type === 'string' ? payload.type : '';
  const delta = (payload as Record<string, unknown>).delta as Record<string, unknown> | undefined;
  const transcript =
    (delta?.transcript as string | undefined) ??
    (typeof payload.transcript === 'string' ? payload.transcript : undefined) ??
    (typeof payload.text === 'string' ? payload.text : undefined) ??
    (typeof payload.delta === 'string' ? payload.delta : undefined);

  if (!transcript) return null;

  const isFinal = type.endsWith('.completed') || type.endsWith('.complete') || type.includes('completed');
  const words = toTranscriptWords((payload as Record<string, unknown>).words);

  return {
    provider: 'openai',
    isFinal,
    text: transcript,
    words,
    timestamp: Date.now(),
    channel: 'mic',
  };
}

async function collectStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.once('end', () => resolve());
    stream.once('error', (err) => reject(err));
  });
  return Buffer.concat(chunks);
}

function createWavFromPcm16k(pcm: Buffer, sampleRate: number): Buffer {
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
    const model = DEFAULT_STREAMING_MODEL;
    const language = normalizeIsoLanguageCode(opts.language);
    const sourceSampleRate = opts.sampleRateHz ?? 16_000;
    // OpenAI Realtime transcription benefits from periodic commits even when server VAD is enabled.
    // Always enable manual commits so buffered audio is flushed at least once per interval.
    const manualCommit = true;
    // For transcription, the connection itself must omit the model query param;
    // the transcription model is supplied inside the session.update payload.
    // Passing gpt-4o-transcribe in the URL causes the Realtime API to reject
    // the session with “model ... is not supported in transcription mode”.
    const url = `${OPENAI_REALTIME_WS}?intent=transcription`;
    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    const listeners: {
      data: Array<(t: PartialTranscript) => void>;
      error: Array<(err: Error) => void>;
      close: Array<() => void>;
    } = { data: [], error: [], close: [] };

    const resampler = new SampleRate24kResampler(sourceSampleRate);
    let openResolved = false;
    let pingTimer: NodeJS.Timeout | null = null;
    let manualCommitTimer: NodeJS.Timeout | null = null;
    let bufferedBytes = 0;
    const resetBufferedState = () => {
      hasAudio = false;
      bufferedBytes = 0;
      clearManualCommitTimer();
    };
    const minBufferedMs = 100;
    const minBufferedBytes = Math.ceil((RESAMPLED_SAMPLE_RATE * 2 * minBufferedMs) / 1000); // mono 16-bit

    const wsReady = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('openai realtime connection timeout'));
      }, WS_OPEN_TIMEOUT_MS);

      ws.once('open', () => {
        clearTimeout(timer);
        openResolved = true;
        // Realtime transcription sessions require `transcription_session.update`
        // (not session.update) when connecting with intent=transcription.
        ws.send(
          JSON.stringify({
            type: 'transcription_session.update',
            session: {
              input_audio_format: 'pcm16',
              input_audio_transcription: {
                model,
                // OpenAI Realtime only accepts ISO 639-1/3 codes (e.g. "ja", "en").
                // The UI sends BCP-47 (e.g. "ja-JP"), so normalize here.
                language: language ?? null,
                prompt: opts.dictionaryPhrases?.join(', ') ?? '',
              },
              turn_detection:
                opts.enableVad === false
                  ? null
                  : {
                      type: 'server_vad',
                      silence_duration_ms: 500,
                      prefix_padding_ms: 300,
                      threshold: 0.5,
                    },
              input_audio_noise_reduction: { type: 'near_field' },
            },
          })
        );
        resolve();
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      ws.once('close', () => {
        clearTimeout(timer);
        if (!openResolved) reject(new Error('openai realtime socket closed before ready'));
      });
    });

    const clearManualCommitTimer = () => {
      if (manualCommitTimer) {
        clearTimeout(manualCommitTimer);
        manualCommitTimer = null;
      }
    };

    let hasAudio = false;

    const commitBuffer = async (force = false) => {
      if (!hasAudio) return; // avoid OpenAI "buffer too small" when nothing was sent
      if (!force && bufferedBytes < minBufferedBytes) return; // wait until we have at least 100ms buffered
      await wsReady;
      ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      bufferedBytes = 0;
    };

    const scheduleManualCommit = () => {
      if (!manualCommit) return;
      if (manualCommitTimer) return;
      manualCommitTimer = setTimeout(() => {
        manualCommitTimer = null;
        void commitBuffer().catch((err) => listeners.error.forEach((cb) => cb(err as Error)));
      }, OPENAI_MANUAL_COMMIT_INTERVAL_MS);
    };

    ws.on('message', (raw) => {
      try {
        const payload = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(raw.toString());
        if (OPENAI_DEBUG) {
          console.debug('[openai:ws message]', JSON.stringify(payload).slice(0, 500));
        }
        const transcript = toPartialTranscript(payload);
        if (transcript) {
          listeners.data.forEach((cb) => cb(transcript));
          if (transcript.isFinal) {
            // Server VAD already flushed its internal buffer; avoid redundant commits that
            // trigger "buffer too small" errors by clearing local counters.
            resetBufferedState();
          }
        } else if (payload?.type === 'error' && typeof payload?.error === 'object') {
          const err = payload.error as { message?: string };
          const message = err.message ?? 'openai realtime error';
          if (message.toLowerCase().includes('buffer too small')) {
            // Ignore benign commit errors that can occur when server VAD auto-committed
            // the buffer; just reset local counters and continue.
            resetBufferedState();
            return;
          }
          listeners.error.forEach((cb) => cb(new Error(message)));
        }
      } catch (err) {
        listeners.error.forEach((cb) => cb(err as Error));
      }
    });

    ws.on('error', (err) => {
      if (OPENAI_DEBUG) {
        console.debug('[openai:ws error]', err);
      }
      listeners.error.forEach((cb) => cb(err as Error));
    });

    ws.on('close', (code, reason) => {
      if (pingTimer) clearInterval(pingTimer);
      if (OPENAI_DEBUG) {
        console.debug('[openai:ws close]', code, reason?.toString());
      }
      const isNormalClose = code === 1000 || code === 1005;
      if (!isNormalClose) {
      const message =
          reason && reason.toString().length > 0
            ? `openai realtime socket closed: ${code} ${reason.toString()}`
            : `openai realtime socket closed: ${code}`;
        listeners.error.forEach((cb) => cb(new Error(message)));
      }
      clearManualCommitTimer();
      listeners.close.forEach((cb) => cb());
    });

    const controller = {
      async sendAudio(chunk: ArrayBufferLike) {
        await wsReady;
        const pcm = Buffer.from(chunk);
        const upsampled = resampler.resample(pcm);
        if (upsampled.length === 0) return;
        hasAudio = true;
        bufferedBytes += upsampled.length;
        ws.send(
          JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: upsampled.toString('base64'),
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
        // If no audio was ever sent, just close without commit to avoid buffer errors.
        if (hasAudio) {
          await commitBuffer(true).catch(() => {
            // ignore commit errors during shutdown
          });
        }
        ws.close();
      },
    };

    // keepalive to prevent idle timeouts on long recordings
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
        } catch (err) {
          if (OPENAI_DEBUG) console.debug('[openai:ws ping error]', err);
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
    const model = DEFAULT_BATCH_MODEL;
    const language = normalizeIsoLanguageCode(opts.language);
    const controller = new AbortController();
    const hardTimer = setTimeout(
      () => controller.abort(new Error('openai batch hard timeout')),
      BATCH_HARD_TIMEOUT_MS
    );
    let idleTimer: NodeJS.Timeout | null = null;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => controller.abort(new Error('openai batch idle timeout')),
        BATCH_IDLE_TIMEOUT_MS
      );
    };
    const clearIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    };
    pcm.on('data', resetIdle);
    pcm.on('end', clearIdle);
    pcm.on('close', clearIdle);
    resetIdle();

    let audioBuf: Buffer;
    try {
      audioBuf = await collectStream(pcm);
    } finally {
      clearTimeout(hardTimer);
      clearIdle();
      pcm.off('data', resetIdle);
      pcm.off('end', clearIdle);
      pcm.off('close', clearIdle);
    }

    const wav = createWavFromPcm16k(audioBuf, opts.sampleRateHz);

    const callTranscribe = async (useModel: string) => {
      const form = new FormData();
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
      form.append('model', useModel);
      if (language) form.append('language', language);
      // Prevent 400s on longer clips by letting the API choose chunking automatically.
      form.append('chunking_strategy', 'auto');
      form.append('response_format', 'json');
      form.append('timestamp_granularities[]', 'word');
      if (opts.dictionaryPhrases?.length) {
        form.append('prompt', opts.dictionaryPhrases.join(', '));
      }

      const res = await fetch(OPENAI_AUDIO_TRANSCRIPTION, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: form,
        signal: controller.signal,
      });

      return res;
    };

    let res = await callTranscribe(model);
    if (!res.ok && FALLBACK_BATCH_MODEL && FALLBACK_BATCH_MODEL !== model) {
      const text = await res.text().catch(() => '');
      if (OPENAI_DEBUG) console.warn('[openai] primary model failed, retrying fallback', { status: res.status, text });
      res = await callTranscribe(FALLBACK_BATCH_MODEL);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`openai batch failed: ${res.status} ${text || res.statusText}`);
    }
    const payload = (await res.json()) as Record<string, unknown>;
    const words = toTranscriptWords(payload.words);
    const text =
      typeof payload.text === 'string'
        ? payload.text
        : typeof payload.transcript === 'string'
          ? payload.transcript
          : '';

    return {
      provider: this.id,
      text,
      words,
    };
  }
}
