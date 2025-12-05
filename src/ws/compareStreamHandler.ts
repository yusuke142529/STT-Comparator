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
  RealtimeLatencySummary,
  RealtimeLogPayload,
  RealtimeTranscriptLogEntry,
  StreamingConfigMessage,
  StreamErrorMessage,
  StreamSessionMessage,
  StreamTranscriptMessage,
  StorageDriver,
  StreamingController,
} from '../types.js';
import type { RealtimeTranscriptLogWriter } from '../storage/realtimeTranscriptStore.js';

const HEADER_BYTES = 16; // seq(uint32) + captureTs(float64) + durationMs(float32)

type ProviderSession = {
  controller: StreamingController;
  latencies: number[];
  lastTranscriptSignature: string | null;
  degraded: boolean;
  failed: boolean;
  pending?: Promise<void>;
  pendingCount: number;
  firstSentAt: number | null;
  lastSentAt: number | null;
  firstCaptureTs: number | null;
  lastCaptureTs: number | null;
  closed: boolean;
  cleanupPromise?: Promise<void>;
  captureTsQueue: Array<number | undefined>;
  droppedMs: number;
};

export async function handleCompareStreamConnection(
  ws: WebSocket,
  providers: ProviderId[],
  lang: string,
  latencyStore: StorageDriver<RealtimeLatencySummary>,
  logStore?: RealtimeTranscriptLogWriter
) {
  const config = await loadConfig();
  const adapters = providers.map((id) => ({ id, adapter: getAdapter(id) }));

  let transcoder: ReturnType<typeof spawnPcmTranscoder> | null = null;
  const pcmQueue: Array<{ chunk: Buffer; captureTs?: number }> = [];
  let queuedBytes = 0;
  let sessionStarted = false;
  const sessions = new Map<ProviderId, ProviderSession>();
  const sessionId = randomUUID();
  const startedAt = new Date().toISOString();
  const maxQueueBytes = config.ws?.maxPcmQueueBytes ?? 5 * 1024 * 1024;
  const compareWs = config.ws?.compare ?? {};
  const backlogSoft = compareWs.backlogSoft ?? 8;
  const backlogHard = compareWs.backlogHard ?? Math.max(backlogSoft * 4, 32);
  const maxDropMs = compareWs.maxDropMs ?? 1000;
  const chunkDurationMs = config.audio.chunkMs ?? 250;
  let closed = false;
  let expectsPcm = false;
  let sessionDegraded = false;
  let closeResolve: (() => void) | null = null;
  const closePromise = new Promise<void>((resolve) => {
    closeResolve = resolve;
  });
  // Expose for tests/diagnostics without affecting runtime behavior.
  Reflect.set(ws as Record<string, unknown>, '__compareClosePromise', closePromise);

  const ensureTranscoder = () => {
    if (expectsPcm) return null;
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

  const recordLog = (provider: ProviderId | null, payload: RealtimeLogPayload) => {
    if (!logStore || !provider) return;
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

  const buildTranscriptSignature = (provider: ProviderId, payload: StreamTranscriptMessage): string =>
    `${provider}:${payload.channel}:${payload.isFinal ? 'final' : 'interim'}:${payload.text}`;

  const shouldEmitTranscript = (provider: ProviderId, payload: StreamTranscriptMessage): boolean => {
    const signature = buildTranscriptSignature(provider, payload);
    const session = sessions.get(provider);
    if (!session) return false;
    if (session.lastTranscriptSignature === signature) {
      return false;
    }
    session.lastTranscriptSignature = signature;
    return true;
  };

  function sendJson(
    payload: StreamTranscriptMessage | StreamErrorMessage | StreamSessionMessage,
    provider: ProviderId | null = null
  ) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
    recordLog(provider, payload as RealtimeLogPayload);
  }

  const closeSession = (provider: ProviderId, session: ProviderSession) => {
    if (session.closed) return;
    session.closed = true;
    session.cleanupPromise = (async () => {
      try {
        await session.pending?.catch(() => undefined);
        await session.controller.end().catch(() => undefined);
      } catch (error) {
        logger.warn({ event: 'provider_end_error', provider, message: (error as Error).message });
      }
      try {
        await session.controller.close().catch(() => undefined);
      } catch (error) {
        logger.warn({ event: 'provider_close_error', provider, message: (error as Error).message });
      }
      // Reset pending to a resolved promise so future fanout chains do not await stale errors.
      session.pending = Promise.resolve();
      session.pendingCount = 0;
    })();
  };

  const markProviderFailed = (provider: ProviderId, err: Error) => {
    const session = sessions.get(provider);
    if (!session || session.failed) return;
    session.failed = true;
    sendJson({ type: 'error', message: err.message, provider } as StreamErrorMessage & { provider: ProviderId }, provider);
    closeSession(provider, session);
    if ([...sessions.values()].every((s) => s.failed)) {
      handleFatal(err);
    }
  };

  async function flushQueue() {
    if (sessions.size === 0) return;
    while (pcmQueue.length > 0) {
      const entry = pcmQueue.shift();
      if (!entry) break;
      queuedBytes -= entry.chunk.length;
      await fanoutChunk(entry.chunk, entry.captureTs);
    }
  }

  const fanoutChunk = async (chunk: Buffer, captureTs?: number) => {
    if (sessions.size === 0) return;
    const now = Date.now();
    for (const [provider, session] of sessions.entries()) {
      if (session.failed) continue;
      if (session.pendingCount >= backlogHard) {
        markProviderFailed(provider, new Error('provider send backlog hard limit exceeded'));
        continue;
      }
      if (session.pendingCount >= backlogSoft) {
        session.droppedMs += chunkDurationMs;
        if (session.droppedMs > maxDropMs) {
          markProviderFailed(provider, new Error('provider backlog drop budget exceeded'));
        }
        continue;
      }
      if (typeof captureTs === 'number') {
        session.lastCaptureTs = captureTs;
        if (!session.firstCaptureTs) session.firstCaptureTs = captureTs;
      }
      if (!session.firstSentAt) session.firstSentAt = now;
      session.lastSentAt = now;
      session.pendingCount += 1;
      session.captureTsQueue.push(captureTs);
      const sendPromise = (session.pending ?? Promise.resolve())
        .then(() => session.controller.sendAudio(bufferToArrayBuffer(chunk), { captureTs }))
        .catch((err) => {
          markProviderFailed(provider, err as Error);
        })
        .finally(() => {
          session.pendingCount -= 1;
          if (session.pendingCount < backlogSoft) {
            session.droppedMs = 0;
          }
        });
      session.pending = sendPromise;
    }
  };

  const flushChunk = async (chunk: Buffer, captureTs?: number) => {
    if (sessions.size === 0) {
      pcmQueue.push({ chunk, captureTs });
      queuedBytes += chunk.length;
      if (queuedBytes > maxQueueBytes) {
        handleFatal(new Error('audio buffer limit exceeded'));
      }
      return;
    }
    await fanoutChunk(chunk, captureTs);
  };

  function handleFatal(err: Error) {
    if (closed) return;
    closed = true;
    sendJson({ type: 'error', message: err.message } as StreamErrorMessage);
    transcoder?.end();
    ws.close();
  }

  ws.on('message', (data, isBinary) => {
    void (async () => {
      if (!sessionStarted && isBinary) {
        sendJson({ type: 'error', message: 'config message required before audio' } as StreamErrorMessage);
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

          await Promise.all(
            adapters.map(async ({ id, adapter }) => {
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

              const providerSession: ProviderSession = {
                controller: streamingSession.controller,
                latencies: [],
                lastTranscriptSignature: null,
                degraded: sessionDegraded,
                failed: false,
                pendingCount: 0,
                firstSentAt: null,
                lastSentAt: null,
                firstCaptureTs: null,
                lastCaptureTs: null,
                closed: false,
                captureTsQueue: [],
                droppedMs: 0,
              };
              sessions.set(id, providerSession);

              streamingSession.onData((transcript) => {
                const session = sessions.get(id);
                if (!session || session.failed) return;
                const originCaptureTs =
                  session.captureTsQueue.shift() ??
                  session.lastCaptureTs ??
                  session.firstCaptureTs ??
                  session.lastSentAt ??
                  session.firstSentAt;
                const latencyMs = typeof originCaptureTs === 'number' ? Date.now() - originCaptureTs : 0;
                const payload: StreamTranscriptMessage = {
                  type: 'transcript',
                  ...transcript,
                  provider: transcript.provider ?? id,
                  channel: transcript.channel ?? 'mic',
                  latencyMs,
                  originCaptureTs: originCaptureTs ?? undefined,
                  degraded: sessionDegraded || transcript.degraded,
                };
                if (!shouldEmitTranscript(id, payload)) return;
                if (typeof latencyMs === 'number') providerSession.latencies.push(latencyMs);
                sendJson(payload, id);
              });

              streamingSession.onError((err) => {
                markProviderFailed(id, err);
              });

              streamingSession.onClose(() => {
                markProviderFailed(id, new Error('stream closed'));
              });

              sendJson({ type: 'session', sessionId, provider: id, startedAt } as StreamSessionMessage, id);
            })
          );

          await flushQueue();
          return;
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Invalid initial config message';
          sendJson({ type: 'error', message } as StreamErrorMessage);
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
          await flushChunk(pcmChunk, captureTs);
          return;
        }
        const activeTranscoder = ensureTranscoder();
        await activeTranscoder?.input(buffer);
      }
    })();
  });

  ws.on('close', () => {
    closeResolve?.();
    void (async () => {
      try {
        transcoder?.end();
        for (const [provider, session] of sessions.entries()) {
          if (!session.closed) {
            closeSession(provider, session);
          }
          await session.cleanupPromise?.catch(() => undefined);
          await session.pending?.catch(() => undefined);
        }

        await Promise.all(
          Array.from(sessions.entries()).map(([provider, session]) =>
            persistLatency(
              session.latencies,
              { sessionId, provider, lang, startedAt },
              latencyStore
            ).catch((error) => logger.error({ event: 'latency_persist_error', message: error.message }))
          )
        );

        for (const provider of sessions.keys()) {
          recordLog(provider, { type: 'session_end', endedAt: new Date().toISOString() });
        }
      } catch (error) {
        logger.error({ event: 'ws_close_error', message: (error as Error).message });
      }
    })();
  });

  ws.on('error', (err) => {
    logger.error({ event: 'ws_error', message: err.message });
    sendJson({ type: 'error', message: err.message } as StreamErrorMessage);
  });
}

function normalizeRawData(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}
