import type { WebSocket, RawData } from 'ws';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config.js';
import { getAdapter } from '../adapters/index.js';
import { logger } from '../logger.js';
import { spawnPcmTranscoder } from '../utils/ffmpeg.js';
import { bufferToArrayBuffer } from '../utils/buffer.js';
import { persistLatency } from '../utils/latency.js';
import { streamingConfigMessageSchema } from '../validation.js';
import type {
  ProviderId,
  RealtimeLogPayload,
  RealtimeLatencySummary,
  RealtimeTranscriptLogEntry,
  StreamingConfigMessage,
  StreamErrorMessage,
  StreamTranscriptMessage,
  StreamSessionMessage,
  StorageDriver,
} from '../types.js';
import type { RealtimeTranscriptLogWriter } from '../storage/realtimeTranscriptStore.js';

const HEADER_BYTES = 16; // seq(uint32) + captureTs(float64) + durationMs(float32)

export async function handleStreamConnection(
  ws: WebSocket,
  provider: ProviderId,
  lang: string,
  latencyStore: StorageDriver<RealtimeLatencySummary>,
  logStore?: RealtimeTranscriptLogWriter
) {
  const config = await loadConfig();
  const adapter = getAdapter(provider);
  let transcoder: ReturnType<typeof spawnPcmTranscoder> | null = null;
  const pcmQueue: Buffer[] = [];
  let queuedBytes = 0;
  let sessionStarted = false;
  let controller: Awaited<ReturnType<typeof adapter.startStreaming>>['controller'] | null = null;
  let firstAudioSentAt: number | null = null;
  let lastAudioSentAt: number | null = null;
  let firstCaptureTs: number | null = null;
  let lastCaptureTs: number | null = null;
  const sessionId = randomUUID();
  const latencies: number[] = [];
  let lastTranscriptSignature: string | null = null;
  const startedAt = new Date().toISOString();
  const maxQueueBytes = config.ws?.maxPcmQueueBytes ?? 5 * 1024 * 1024;
  let closed = false;
  let expectsPcm = false;
  let sessionDegraded = false;
  const ensureTranscoder = () => {
    if (expectsPcm) {
      return null;
    }
    if (transcoder) return transcoder;
    const spawned = spawnPcmTranscoder(config.audio);
    transcoder = spawned;
    transcoder.stream.on('data', (chunk: Buffer) => {
      void flushChunk(chunk);
    });
    transcoder.onError((err) => handleFatal(err));
    transcoder.onClose((code) => {
      if (closed) return;
      if (typeof code === 'number' && code !== 0) {
        handleFatal(new Error(`ffmpeg exited with code ${code}`));
      }
    });
    return transcoder;
  };
  const recordLog = (payload: RealtimeLogPayload) => {
    if (!logStore) return;
    const entry: RealtimeTranscriptLogEntry = {
      sessionId,
      provider,
      lang,
      recordedAt: new Date().toISOString(),
      payload,
    };
    void logStore
      .append(entry)
      .catch((error) => logger.error({ event: 'realtime_log_error', message: error.message }));
  };

  const buildTranscriptSignature = (payload: StreamTranscriptMessage): string =>
    `${payload.channel}:${payload.isFinal ? 'final' : 'interim'}:${payload.text}`;

  const shouldEmitTranscript = (payload: StreamTranscriptMessage): boolean => {
    const signature = buildTranscriptSignature(payload);
    if (lastTranscriptSignature === signature) {
      return false;
    }
    lastTranscriptSignature = signature;
    return true;
  };

  function sendJson(payload: StreamTranscriptMessage | StreamErrorMessage | StreamSessionMessage) {
    ws.send(JSON.stringify(payload));
    recordLog(payload);
  }

  async function flushQueue() {
    if (!controller) return;
    while (pcmQueue.length > 0) {
      const chunk = pcmQueue.shift();
      if (!chunk) break;
      queuedBytes -= chunk.length;
      try {
        await controller.sendAudio(bufferToArrayBuffer(chunk));
      } catch (err) {
        return handleFatal(err as Error);
      }
      const now = Date.now();
      if (!firstAudioSentAt) firstAudioSentAt = now;
      lastAudioSentAt = now;
    }
  }

  const flushChunk = async (chunk: Buffer) => {
    if (!controller) {
      pcmQueue.push(chunk);
      queuedBytes += chunk.length;
      if (queuedBytes > maxQueueBytes) {
        handleFatal(new Error('audio buffer limit exceeded'));
      }
      return;
    }
    try {
      await controller.sendAudio(bufferToArrayBuffer(chunk));
    } catch (err) {
      return handleFatal(err as Error);
    }
    const now = Date.now();
    if (!firstAudioSentAt) firstAudioSentAt = now;
    lastAudioSentAt = now;
  };

  function handleFatal(err: Error) {
    if (closed) return;
    closed = true;
    sendJson({ type: 'error', message: err.message });
    transcoder?.end();
    ws.close();
  }

  ws.on('message', (data, isBinary) => {
    void (async () => {
      if (!sessionStarted && isBinary) {
        sendJson({ type: 'error', message: 'config message required before audio' });
        transcoder?.end();
        ws.close();
        return;
      }
      if (!sessionStarted && !isBinary) {
        try {
          const parsed = JSON.parse(data.toString());
          const configMsg = streamingConfigMessageSchema.parse(parsed) as StreamingConfigMessage;
          sessionStarted = true;
          expectsPcm = !!configMsg.pcm;
          sessionDegraded = !!configMsg.degraded;
          sendJson({ type: 'session', sessionId, provider, startedAt });
          const streamingSession = await adapter.startStreaming({
            language: lang,
            sampleRateHz: config.audio.targetSampleRate,
            encoding: 'linear16',
            enableInterim: configMsg.enableInterim,
            contextPhrases: configMsg.contextPhrases ?? configMsg.options?.dictionaryPhrases,
            punctuationPolicy: configMsg.options?.punctuationPolicy,
            enableVad: configMsg.options?.enableVad,
            dictionaryPhrases: configMsg.options?.dictionaryPhrases,
            normalizePreset: configMsg.normalizePreset,
          });
          controller = streamingSession.controller;
          streamingSession.onData((transcript) => {
            const baseTs = lastCaptureTs ?? firstCaptureTs ?? lastAudioSentAt ?? firstAudioSentAt;
            const latencyMs = typeof baseTs === 'number' ? Date.now() - baseTs : 0;
            if (typeof latencyMs === 'number') {
              latencies.push(latencyMs);
            }
            const payload: StreamTranscriptMessage = {
              type: 'transcript',
              ...transcript,
              channel: transcript.channel ?? 'mic',
              latencyMs,
              degraded: sessionDegraded,
            };
            if (!shouldEmitTranscript(payload)) {
              return;
            }
            sendJson(payload);
          });
          streamingSession.onError((err) => {
            handleFatal(err);
          });
          streamingSession.onClose(() => {
            ws.close();
          });
          await flushQueue();
          return;
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Invalid initial config message';
          sendJson({ type: 'error', message });
          transcoder?.end();
          ws.close();
          return;
        }
      }

      if (isBinary) {
        const buffer = normalizeRawData(data);
        if (expectsPcm) {
          if (buffer.length <= HEADER_BYTES) {
            return handleFatal(new Error('invalid pcm frame'));
          }
          const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
          const captureTs = view.getFloat64(4, true);
          const pcmStart = HEADER_BYTES;
          const pcmChunk = buffer.subarray(pcmStart);
          lastCaptureTs = captureTs;
          if (!firstCaptureTs) firstCaptureTs = captureTs;
          await flushChunk(pcmChunk);
          return;
        }
        const activeTranscoder = ensureTranscoder();
        await activeTranscoder.input(buffer);
      }
    })();
  });

  ws.on('close', () => {
    void (async () => {
      transcoder?.end();
      await controller?.end();
      await controller?.close();
      await persistLatency(
        latencies,
        {
          sessionId,
          provider,
          lang,
          startedAt,
        },
        latencyStore
      ).catch((error) => logger.error({ event: 'latency_persist_error', message: error.message }));
      recordLog({ type: 'session_end', endedAt: new Date().toISOString() });
    })();
  });

  ws.on('error', (err) => {
    logger.error({ event: 'ws_error', message: err.message });
    sendJson({ type: 'error', message: err.message });
  });
}

function normalizeRawData(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data as ArrayBuffer);
}
