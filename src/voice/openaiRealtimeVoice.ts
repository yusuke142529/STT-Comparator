import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import { logger } from '../logger.js';
import type { VadConfig } from '../types.js';
import { normalizeIsoLanguageCode } from '../utils/language.js';
import { resolveVadConfig } from '../utils/vad.js';

const OPENAI_REALTIME_DEBUG = process.env.OPENAI_REALTIME_DEBUG === 'true';
const OPENAI_PING_INTERVAL_MS = 15_000;
const OPENAI_STREAM_BUFFER_HIGH_WATER_BYTES = 5 * 1024 * 1024;
const WS_OPEN_TIMEOUT_MS = 10_000;
const WS_CLOSE_TIMEOUT_MS = 2_000;
const OPENAI_AUDIO_INPUT_RATE_HZ = 24_000;

function getDefaultRealtimeModel(): string {
  return process.env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime';
}

function getDefaultTranscriptionModel(): string {
  // Realtime voice currently supports: whisper-1, gpt-4o-transcribe, gpt-4o-mini-transcribe (+ dated snapshots).
  // Use the alias so the app follows the newest snapshot without hard-coding a date.
  return process.env.OPENAI_REALTIME_TRANSCRIBE_MODEL ?? 'gpt-4o-mini-transcribe';
}

function getDefaultVoice(): string {
  return process.env.OPENAI_REALTIME_VOICE ?? 'alloy';
}

const OPENAI_REALTIME_WS_BASE = 'wss://api.openai.com/v1/realtime';
const ALLOWED_OPENAI_REALTIME_HOSTS = new Set(['api.openai.com']);

export type OpenAiRealtimeVoiceSession = {
  ready: Promise<void>;
  appendAudio(pcm16le24kMono: Buffer): Promise<void>;
  cancelResponse(): Promise<void>;
  truncateOutputAudio(itemId: string, audioEndMs: number): Promise<void>;
  close(): Promise<void>;
};

export type OpenAiRealtimeVoiceHandlers = {
  onSpeechStarted?: () => void;
  onUserTranscript?: (payload: { text: string; isFinal: boolean }) => void;
  onResponseCreated?: (payload: { responseId: string }) => void;
  onResponseDone?: (payload: { responseId: string; status?: string }) => void;
  onAssistantAudioDelta?: (payload: { responseId: string; itemId?: string; pcm: Buffer }) => void;
  onAssistantAudioDone?: (payload: { responseId: string }) => void;
  onAssistantTextDelta?: (payload: { responseId: string; delta: string }) => void;
  onAssistantTextDone?: (payload: { responseId: string; text: string }) => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
};

function requireApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error('OpenAI API key is required. Set OPENAI_API_KEY in .env');
  }
  return key;
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

function toError(err: unknown, fallbackMessage = 'unknown error'): Error {
  if (err instanceof Error) return err;
  if (typeof err === 'string') return new Error(err);
  try {
    return new Error(JSON.stringify(err));
  } catch {
    return new Error(fallbackMessage);
  }
}

function getRealtimeWsUrl(model: string): string {
  const url = new URL(OPENAI_REALTIME_WS_BASE);
  url.searchParams.set('model', model);

  if (url.protocol !== 'wss:') {
    throw new Error('OpenAI realtime URL must use wss');
  }
  if (url.username || url.password) {
    throw new Error('OpenAI realtime URL must not include credentials');
  }
  if (!ALLOWED_OPENAI_REALTIME_HOSTS.has(url.hostname) || (url.port && url.port !== '443')) {
    throw new Error(`OpenAI realtime URL host is not allowed: ${url.host}`);
  }
  if (url.pathname !== '/v1/realtime') {
    throw new Error(`OpenAI realtime URL path is not allowed: ${url.pathname}`);
  }
  return url.toString();
}

function getTurnDetection(vad?: VadConfig): Record<string, unknown> {
  const resolved = resolveVadConfig(vad);
  return {
    type: 'server_vad',
    silence_duration_ms: resolved.silenceDurationMs,
    prefix_padding_ms: resolved.prefixPaddingMs,
    threshold: resolved.threshold,
    // Let the server start/cancel responses automatically when speech begins/ends.
    create_response: true,
    interrupt_response: true,
  };
}

export function startOpenAiRealtimeVoiceSession(
  opts: {
    lang: string;
    systemPrompt: string;
    model?: string;
    transcriptionModel?: string;
    voice?: string;
    vad?: VadConfig;
  },
  handlers: OpenAiRealtimeVoiceHandlers
): OpenAiRealtimeVoiceSession {
  const apiKey = requireApiKey();
  const model = (opts.model ?? getDefaultRealtimeModel()).trim();
  const transcriptionModel = (opts.transcriptionModel ?? getDefaultTranscriptionModel()).trim();
  const voice = (opts.voice ?? getDefaultVoice()).trim();
  const language = normalizeIsoLanguageCode(opts.lang) ?? '';

  const url = getRealtimeWsUrl(model);

  if (OPENAI_REALTIME_DEBUG) {
    logger.debug({
      event: 'openai_realtime_voice_connect',
      model,
      transcriptionModel,
      voice,
      language,
      url,
    });
  }

  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  const userTranscriptByItemId = new Map<string, string>();
  const assistantTextByResponseId = new Map<string, string>();
  const assistantAudioTranscriptByResponseId = new Map<string, string>();

  let pingTimer: NodeJS.Timeout | null = null;
  let closeRequested = false;

  let readySettled = false;
  let resolveReady: (() => void) | null = null;
  let rejectReady: ((err: Error) => void) | null = null;
  let readyTimer: NodeJS.Timeout | null = null;
  let sawSessionCreated = false;
  let sawSessionUpdated = false;

  const settleReady = (err?: Error) => {
    if (readySettled) return;
    readySettled = true;
    if (readyTimer) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
    const resolve = resolveReady;
    const reject = rejectReady;
    resolveReady = null;
    rejectReady = null;
    if (err) {
      reject?.(err);
      return;
    }
    resolve?.();
  };

  const maybeResolveReady = () => {
    if (!sawSessionCreated) return;
    if (!sawSessionUpdated) return;
    settleReady();
  };

  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;

    readyTimer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      settleReady(new Error('openai realtime connection timeout'));
    }, WS_OPEN_TIMEOUT_MS);

    ws.once('open', () => {
      try {
        ws.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              type: 'realtime',
              model,
              instructions: opts.systemPrompt,
              // Some Realtime deployments reject mixed modalities. We only require audio; UI text is sourced from
              // response audio transcripts when available.
              output_modalities: ['audio'],
              audio: {
                output: {
                  voice,
                  format: { type: 'audio/pcm', rate: OPENAI_AUDIO_INPUT_RATE_HZ },
                },
                input: {
                  format: { type: 'audio/pcm', rate: OPENAI_AUDIO_INPUT_RATE_HZ },
                  noise_reduction: { type: 'near_field' },
                  transcription: {
                    model: transcriptionModel,
                    language: language || undefined,
                    prompt: '',
                  },
                  turn_detection: getTurnDetection(opts.vad),
                },
              },
            },
          })
        );
      } catch (err) {
        settleReady(toError(err, 'openai realtime send failed'));
      }
    });

    ws.once('error', (err) => {
      settleReady(toError(err, 'openai realtime socket error'));
    });

    ws.once('close', () => {
      settleReady(new Error('openai realtime socket closed before ready'));
    });
  });
  void ready.catch(() => undefined);

  const sendJson = async (payload: Record<string, unknown>) => {
    await ready;
    if (ws.readyState !== WebSocket.OPEN) {
      throw new Error('openai realtime socket is not open');
    }
    ws.send(JSON.stringify(payload));
  };

  const emitError = (err: unknown) => {
    const e = toError(err, 'openai realtime voice error');
    handlers.onError?.(e);
  };

  ws.on('message', (raw) => {
    if (closeRequested) return;
    const text = rawDataToUtf8(raw);
    if (!text) return;

    let message: unknown;
    try {
      message = JSON.parse(text) as unknown;
    } catch {
      return;
    }

    if (!isRecord(message)) return;
    const type = typeof message.type === 'string' ? message.type : '';
    if (!type) return;

    if (type === 'error') {
      const errMsg =
        isRecord(message.error) && typeof message.error.message === 'string'
          ? message.error.message
          : typeof message.message === 'string'
            ? message.message
            : 'openai realtime error';
      const err = new Error(errMsg);
      if (!readySettled) {
        settleReady(err);
        return;
      }
      emitError(err);
      return;
    }

    if (type === 'session.created') {
      sawSessionCreated = true;
      maybeResolveReady();
      return;
    }

    if (type === 'session.updated') {
      sawSessionUpdated = true;
      maybeResolveReady();
      return;
    }

    if (type === 'input_audio_buffer.speech_started') {
      handlers.onSpeechStarted?.();
      return;
    }

    if (type === 'response.created') {
      const responseId =
        isRecord(message.response) && typeof message.response.id === 'string'
          ? message.response.id
          : typeof message.response_id === 'string'
            ? message.response_id
            : '';
      if (responseId) {
        handlers.onResponseCreated?.({ responseId });
      }
      return;
    }

    if (type === 'response.done') {
      const responseId =
        isRecord(message.response) && typeof message.response.id === 'string'
          ? message.response.id
          : typeof message.response_id === 'string'
            ? message.response_id
            : '';
      if (!responseId) return;
      const status =
        isRecord(message.response) && typeof message.response.status === 'string'
          ? message.response.status
          : typeof message.status === 'string'
            ? message.status
            : undefined;
      assistantTextByResponseId.delete(responseId);
      assistantAudioTranscriptByResponseId.delete(responseId);
      handlers.onResponseDone?.({ responseId, status });
      return;
    }

    if (type === 'response.output_audio.delta' || type === 'response.audio.delta') {
      const responseId = typeof message.response_id === 'string' ? message.response_id : '';
      const delta = typeof message.delta === 'string' ? message.delta : '';
      if (!responseId || !delta) return;
      const itemId = typeof message.item_id === 'string' ? message.item_id : undefined;
      try {
        const pcm = Buffer.from(delta, 'base64');
        if (pcm.length > 0) {
          handlers.onAssistantAudioDelta?.({ responseId, itemId, pcm });
        }
      } catch (err) {
        emitError(err);
      }
      return;
    }

    if (type === 'response.output_audio.done' || type === 'response.audio.done') {
      const responseId = typeof message.response_id === 'string' ? message.response_id : '';
      if (responseId) {
        handlers.onAssistantAudioDone?.({ responseId });
      }
      return;
    }

    if (type === 'response.output_text.delta' || type === 'response.text.delta') {
      const responseId = typeof message.response_id === 'string' ? message.response_id : '';
      const delta = typeof message.delta === 'string' ? message.delta : '';
      if (!responseId || !delta) return;
      const prev = assistantTextByResponseId.get(responseId) ?? '';
      const next = prev + delta;
      assistantTextByResponseId.set(responseId, next);
      handlers.onAssistantTextDelta?.({ responseId, delta });
      return;
    }

    if (type === 'response.output_text.done' || type === 'response.text.done') {
      const responseId = typeof message.response_id === 'string' ? message.response_id : '';
      if (!responseId) return;
      const textValue =
        typeof message.text === 'string'
          ? message.text
          : (assistantTextByResponseId.get(responseId) ?? '');
      if (textValue.trim().length > 0) {
        handlers.onAssistantTextDone?.({ responseId, text: textValue });
      }
      return;
    }

    if (type === 'response.output_audio_transcript.delta' || type === 'response.audio_transcript.delta') {
      const responseId = typeof message.response_id === 'string' ? message.response_id : '';
      const delta = typeof message.delta === 'string' ? message.delta : '';
      if (!responseId || !delta) return;
      const prev = assistantAudioTranscriptByResponseId.get(responseId) ?? '';
      assistantAudioTranscriptByResponseId.set(responseId, prev + delta);
      return;
    }

    if (type === 'response.output_audio_transcript.done' || type === 'response.audio_transcript.done') {
      const responseId = typeof message.response_id === 'string' ? message.response_id : '';
      if (!responseId) return;
      const transcriptValue =
        typeof message.transcript === 'string'
          ? message.transcript
          : (assistantAudioTranscriptByResponseId.get(responseId) ?? '');
      if (transcriptValue.trim().length > 0 && !(assistantTextByResponseId.get(responseId) ?? '').trim()) {
        handlers.onAssistantTextDone?.({ responseId, text: transcriptValue });
      }
      return;
    }

    if (type === 'conversation.item.input_audio_transcription.delta') {
      const itemId = typeof message.item_id === 'string' ? message.item_id : '';
      const delta = typeof message.delta === 'string' ? message.delta : '';
      if (!itemId || !delta) return;
      const prev = userTranscriptByItemId.get(itemId) ?? '';
      const next = prev + delta;
      userTranscriptByItemId.set(itemId, next);
      handlers.onUserTranscript?.({ text: next, isFinal: false });
      return;
    }

    if (type === 'conversation.item.input_audio_transcription.segment') {
      const textValue = typeof message.text === 'string' ? message.text : '';
      if (textValue.trim().length > 0) {
        handlers.onUserTranscript?.({ text: textValue, isFinal: false });
      }
      return;
    }

    if (type === 'conversation.item.input_audio_transcription.completed') {
      const itemId = typeof message.item_id === 'string' ? message.item_id : '';
      const transcript = typeof message.transcript === 'string' ? message.transcript : '';
      if (!itemId || !transcript) return;
      userTranscriptByItemId.delete(itemId);
      handlers.onUserTranscript?.({ text: transcript, isFinal: true });
      return;
    }
  });

  ws.on('error', (err) => {
    if (OPENAI_REALTIME_DEBUG) {
      logger.debug({ event: 'openai_realtime_voice_ws_error', message: err.message });
    }
    emitError(err);
  });

  ws.on('close', (code, reason) => {
    if (pingTimer) clearInterval(pingTimer);
    const reasonText = reason?.toString() ?? '';
    if (OPENAI_REALTIME_DEBUG) {
      logger.debug({ event: 'openai_realtime_voice_ws_close', code, reason: reasonText });
    }
    handlers.onClose?.();
  });

  pingTimer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.ping();
    } catch (err) {
      if (OPENAI_REALTIME_DEBUG) {
        logger.debug({ event: 'openai_realtime_voice_ws_ping_error', err: String(err) });
      }
    }
  }, OPENAI_PING_INTERVAL_MS);

  const appendAudio = async (pcm16le24kMono: Buffer) => {
    await ready;
    if (ws.readyState !== WebSocket.OPEN) return;
    if (closeRequested) return;
    if (pcm16le24kMono.length === 0) return;

    while (ws.bufferedAmount > OPENAI_STREAM_BUFFER_HIGH_WATER_BYTES) {
      if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    ws.send(
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: pcm16le24kMono.toString('base64'),
      })
    );
  };

  const cancelResponse = async () => {
    await sendJson({ type: 'response.cancel' });
  };

  const truncateOutputAudio = async (itemId: string, audioEndMs: number) => {
    if (!itemId) return;
    if (!Number.isFinite(audioEndMs) || audioEndMs < 0) return;
    await sendJson({
      type: 'conversation.item.truncate',
      item_id: itemId,
      content_index: 0,
      audio_end_ms: Math.round(audioEndMs),
    });
  };

  const close = async () => {
    if (closeRequested) return;
    closeRequested = true;
    if (pingTimer) clearInterval(pingTimer);

    const waitForClose = new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
    });

    try {
      ws.close();
    } catch {
      // ignore
    }

    await Promise.race([
      waitForClose,
      new Promise<void>((resolve) =>
        setTimeout(() => {
          try {
            ws.terminate();
          } catch {
            // ignore
          }
          resolve();
        }, WS_CLOSE_TIMEOUT_MS)
      ),
    ]);
  };

  return {
    ready,
    appendAudio,
    cancelResponse,
    truncateOutputAudio,
    close,
  };
}
