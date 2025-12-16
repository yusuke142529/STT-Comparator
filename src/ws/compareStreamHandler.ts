import { WebSocket, type RawData } from 'ws';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config.js';
import { getAdapter } from '../adapters/index.js';
import { logger } from '../logger.js';
import { createPcmResampler, spawnPcmTranscoder } from '../utils/ffmpeg.js';
import { bufferToArrayBuffer } from '../utils/buffer.js';
import { persistLatency } from '../utils/latency.js';
import { streamingConfigMessageSchema } from '../validation.js';
import { StreamNormalizer } from './streamNormalizer.js';
import { parseStreamFrame } from '../utils/streamHeader.js';
import {
  getProviderSampleRate,
  isPerProviderTranscodeEnabled,
  requiresHighQualityTranscode,
} from '../utils/providerAudio.js';
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
  NormalizedTranscriptMessage,
} from '../types.js';
import type { RealtimeTranscriptLogWriter } from '../storage/realtimeTranscriptStore.js';

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
  captureTsQueue: Array<{ captureTs: number; durationMs: number; seq: number }>;
  droppedMs: number;
  lastAttributed?: { nextTs: number; durationMs: number };
  inputSampleRate?: number;
  resampler?: ReturnType<typeof createPcmResampler> | null;
  perProviderTranscode: boolean;
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
  const perProviderTranscode = isPerProviderTranscodeEnabled();

  let transcoder: ReturnType<typeof spawnPcmTranscoder> | null = null;
  const pcmQueue: Array<{ chunk: Buffer; meta?: { captureTs: number; durationMs: number; seq: number } }> = [];
  let queuedBytes = 0;
  let sessionStarted = false;
  const sessions = new Map<ProviderId, ProviderSession>();
  const sessionId = randomUUID();
  const startedAt = new Date().toISOString();
  let maxQueueBytes = config.ws?.maxPcmQueueBytes ?? 5 * 1024 * 1024;
  const compareWs = config.ws?.compare ?? {};
  const backlogSoft = compareWs.backlogSoft ?? 8;
  const backlogHard = compareWs.backlogHard ?? Math.max(backlogSoft * 4, 32);
  const maxDropMs = compareWs.maxDropMs ?? 1000;
  const keepaliveMs = config.ws?.keepaliveMs ?? 30_000;
  const maxMissedPongs = config.ws?.maxMissedPongs ?? 2;
  const chunkDurationMs = config.audio.chunkMs ?? 250;
  let closed = false;
  let expectsPcm = false;
  let sessionDegraded = false;
  let keepaliveTimer: NodeJS.Timeout | null = null;
  let missedPongs = 0;
  let normalizer: StreamNormalizer | null = null;
  let clientSampleRate = config.audio.targetSampleRate;
  let closeResolve: (() => void) | null = null;
  const closePromise = new Promise<void>((resolve) => {
    closeResolve = resolve;
  });
  // Expose for tests/diagnostics without affecting runtime behavior.
  Reflect.set(ws as Record<string, unknown>, '__compareClosePromise', closePromise);
  let messageChain: Promise<void> = Promise.resolve();

  const sanitizeCaptureTs = (candidate: number, fallback: number) => {
    if (!Number.isFinite(candidate) || candidate <= 0) return fallback;
    const now = Date.now();
    return candidate > now ? now : candidate;
  };
  const sanitizeDurationMs = (candidate: number, fallback: number) => {
    if (!Number.isFinite(candidate) || candidate <= 0) return fallback;
    return Math.min(candidate, 5_000);
  };

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

  const recordFatalForAllProviders = (message: string) => {
    for (const provider of providers) {
      recordLog(provider, { type: 'error', message, provider });
    }
  };

  const buildTranscriptSignature = (provider: ProviderId, payload: StreamTranscriptMessage): string =>
    `${provider}:${payload.channel}:${payload.speakerId ?? 'unknown'}:${payload.isFinal ? 'final' : 'interim'}:${payload.text}`;

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
    payload: StreamTranscriptMessage | NormalizedTranscriptMessage | StreamErrorMessage | StreamSessionMessage,
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
    session.resampler?.end();
    session.resampler = null;
    session.cleanupPromise = (async () => {
      try {
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
      session.droppedMs = 0;
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

  const deliverChunk = (
    provider: ProviderId,
    session: ProviderSession,
    chunk: Buffer,
    meta?: { captureTs?: number; durationMs?: number; seq?: number }
  ) => {
    if (session.failed) return;
    const now = Date.now();
    const captureTs = meta?.captureTs ?? session.lastCaptureTs ?? now;
    const durationMs = meta?.durationMs ?? chunkDurationMs;
    const seq = meta?.seq ?? 0;

    if (typeof captureTs === 'number') {
      session.lastCaptureTs = captureTs;
      if (!session.firstCaptureTs) session.firstCaptureTs = captureTs;
    }
    if (!session.firstSentAt) session.firstSentAt = now;
    session.lastSentAt = now;

    session.captureTsQueue.push({
      captureTs,
      durationMs,
      seq,
    });

    session.pendingCount += 1;
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
  };

  async function flushQueue() {
    if (sessions.size === 0) return;
    while (pcmQueue.length > 0) {
      const entry = pcmQueue.shift();
      if (!entry) break;
      queuedBytes -= entry.chunk.length;
      await fanoutChunk(entry.chunk, entry.meta);
    }
  }

  const fanoutChunk = async (
    chunk: Buffer,
    meta?: { captureTs: number; durationMs: number; seq: number }
  ) => {
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
      const durationMs = meta?.durationMs ?? chunkDurationMs;
      const seq = meta?.seq ?? 0;
      const captureTs = meta?.captureTs ?? session.lastCaptureTs ?? now;
      const useResampler = expectsPcm && session.perProviderTranscode && session.resampler;
      const resamplerOutputRate = session.resampler?.outputSampleRate;
      if (useResampler && resamplerOutputRate && resamplerOutputRate !== clientSampleRate) {
        await session.resampler.input(chunk, { captureTs, durationMs, seq });
      } else {
        deliverChunk(provider, session, chunk, { captureTs, durationMs, seq });
      }
    }
  };

  const flushChunk = async (
    chunk: Buffer,
    meta?: { captureTs: number; durationMs: number; seq: number }
  ) => {
    if (sessions.size === 0) {
      pcmQueue.push({ chunk, meta });
      queuedBytes += chunk.length;
      if (queuedBytes > maxQueueBytes) {
        handleFatal(new Error('audio buffer limit exceeded'));
      }
      return;
    }
    await fanoutChunk(chunk, meta);
  };

  function handleFatal(err: Error) {
    if (closed) return;
    closed = true;
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    const allSessionsFailed =
      sessions.size > 0 && [...sessions.values()].every((session) => session.failed);
    if (!allSessionsFailed) {
      recordFatalForAllProviders(err.message);
    }
    sendJson({ type: 'error', message: err.message } as StreamErrorMessage);
    for (const session of sessions.values()) {
      session.resampler?.end();
    }
    transcoder?.end();
    ws.close();
  }

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const parsed = JSON.parse(data.toString()) as { type?: string };
        if (parsed?.type === 'pong') {
          missedPongs = 0;
          return;
        }
      } catch {
        // ignore control frames
      }
    }

    const run = async () => {
      if (closed) return;
      if (!sessionStarted && isBinary) {
        const message = 'config message required before audio';
        recordFatalForAllProviders(message);
        sendJson({ type: 'error', message } as StreamErrorMessage);
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
          if (configMsg.channelSplit === true || configMsg.options?.enableChannelSplit === true) {
            const message = 'channelSplit is not supported in compare mode; disable it or use single-provider streaming';
            recordFatalForAllProviders(message);
            sendJson({ type: 'error', message } as StreamErrorMessage);
            transcoder?.end();
            ws.close();
            return;
          }
          const isMeetingMode = configMsg.options?.meetingMode === true;
          if (isMeetingMode && config.ws?.meeting) {
            maxQueueBytes = config.ws.meeting.maxPcmQueueBytes ?? maxQueueBytes;
          }
          normalizer = new StreamNormalizer({
            bucketMs: config.audio.chunkMs ?? 250,
            preset: configMsg.normalizePreset,
            sessionId,
          });
          clientSampleRate = configMsg.clientSampleRate ?? config.audio.targetSampleRate;

          await Promise.all(
            adapters.map(async ({ id, adapter }) => {
              const providerSampleRate = getProviderSampleRate(id, config);
              const forcedPerProviderTranscode = requiresHighQualityTranscode(id);
              const providerPerProviderTranscode = perProviderTranscode || forcedPerProviderTranscode;
              const effectiveSampleRate = providerPerProviderTranscode ? providerSampleRate : clientSampleRate;

              logger.info({
                event: 'compare_stream_start',
                provider: id,
                lang,
                clientSampleRate,
                effectiveSampleRate,
                perProviderTranscode: providerPerProviderTranscode,
                forcedPerProviderTranscode,
              });

              const streamingSession = await adapter.startStreaming({
                language: lang,
                sampleRateHz: effectiveSampleRate,
                encoding: 'linear16',
                enableInterim: configMsg.enableInterim,
                contextPhrases: configMsg.contextPhrases ?? configMsg.options?.dictionaryPhrases,
                punctuationPolicy: configMsg.options?.punctuationPolicy,
                enableVad: configMsg.options?.enableVad,
                enableDiarization: configMsg.options?.enableDiarization,
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
                lastAttributed: undefined,
                inputSampleRate: clientSampleRate,
                resampler: expectsPcm && providerPerProviderTranscode
                  ? createPcmResampler({
                      inputSampleRate: clientSampleRate,
                      outputSampleRate: providerSampleRate,
                      channels: config.audio.targetChannels,
                    })
                  : null,
                perProviderTranscode: providerPerProviderTranscode,
              };

              providerSession.resampler?.onChunk((chunk, meta) => {
                deliverChunk(id, providerSession, chunk, meta);
              });
              providerSession.resampler?.onError((err) => markProviderFailed(id, err));
              providerSession.resampler?.onClose((code) => {
                if (closed) return;
                if (typeof code === 'number' && code !== 0) {
                  markProviderFailed(id, new Error(`ffmpeg exited with code ${code}`));
                }
              });
              sessions.set(id, providerSession);

              streamingSession.onData((transcript) => {
                const session = sessions.get(id);
                if (!session || session.failed) return;
                const attribution =
                  session.captureTsQueue.shift() ??
                  (session.lastAttributed
                    ? {
                        captureTs: session.lastAttributed.nextTs,
                        durationMs: session.lastAttributed.durationMs,
                        seq: 0,
                      }
                    : null);

                if (attribution) {
                  session.lastAttributed = {
                    nextTs: attribution.captureTs + attribution.durationMs,
                    durationMs: attribution.durationMs,
                  };
                }

                const originCaptureTs =
                  attribution?.captureTs ??
                  session.lastCaptureTs ??
                  session.firstCaptureTs ??
                  session.lastSentAt ??
                  session.firstSentAt ??
                  Date.now();

                const rawLatencyMs = Date.now() - originCaptureTs;
                const latencyMs =
                  Number.isFinite(rawLatencyMs) && rawLatencyMs >= 0 ? rawLatencyMs : undefined;
                const payload: StreamTranscriptMessage = {
                  type: 'transcript',
                  ...transcript,
                  provider: transcript.provider ?? id,
                  channel: transcript.channel ?? 'mic',
                  latencyMs,
                  originCaptureTs: Number.isFinite(originCaptureTs) ? originCaptureTs : undefined,
                  degraded: sessionDegraded || transcript.degraded,
                };
                if (!shouldEmitTranscript(id, payload)) return;
                if (payload.isFinal && latencyMs !== undefined) providerSession.latencies.push(latencyMs);
                const normalized = normalizer?.ingest(id, {
                  provider: id,
                  isFinal: payload.isFinal,
                  text: payload.text,
                  words: payload.words,
                  timestamp: payload.originCaptureTs ?? payload.timestamp ?? Date.now(),
                  channel: payload.channel,
                  latencyMs: payload.latencyMs,
                  originCaptureTs: payload.originCaptureTs,
                  confidence: payload.confidence,
                  punctuationApplied: payload.punctuationApplied,
                  casingApplied: payload.casingApplied,
                });
                sendJson(payload, id);
                if (normalized) {
                  const normalizedMsg: NormalizedTranscriptMessage = { type: 'normalized', ...normalized };
                  sendJson(normalizedMsg, id);
                }
              });

              streamingSession.onError((err) => {
                markProviderFailed(id, err);
              });

              streamingSession.onClose(() => {
                markProviderFailed(id, new Error('stream closed'));
              });

              sendJson(
                {
                  type: 'session',
                  sessionId,
                  provider: id,
                  startedAt,
                  inputSampleRate: clientSampleRate,
                  audioSpec: { sampleRate: providerSampleRate, channels: 1, format: 'pcm16le' },
                } as StreamSessionMessage,
                id
              );
            })
          );

          keepaliveTimer = setInterval(() => {
            if (closed) return;
            if (missedPongs >= maxMissedPongs) {
              handleFatal(new Error('stream keepalive timeout'));
              return;
            }
            missedPongs += 1;
            try {
              ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
            } catch {
              /* ignore */
            }
          }, keepaliveMs);

          await flushQueue();
          return;
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Invalid initial config message';
          recordFatalForAllProviders(message);
          sendJson({ type: 'error', message } as StreamErrorMessage);
          transcoder?.end();
          ws.close();
          return;
        }
      }

      if (!isBinary) return;

      const buffer = normalizeRawData(data);
      if (expectsPcm) {
        try {
          const { header, pcm } = parseStreamFrame(buffer);
          const baseDuration = chunkDurationMs;
          const captureTs = sanitizeCaptureTs(header.captureTs, Date.now());
          const durationMs = sanitizeDurationMs(header.durationMs || baseDuration, baseDuration);
          await flushChunk(pcm, { captureTs, durationMs, seq: header.seq });
          return;
        } catch (err) {
          handleFatal(err as Error);
          return;
        }
      }

      const activeTranscoder = ensureTranscoder();
      await activeTranscoder?.input(buffer);
    };

    if (closed) return;
    messageChain = messageChain.then(run).catch((err) => handleFatal(err as Error));
  });

  ws.on('close', () => {
    closeResolve?.();
    void (async () => {
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      try {
        transcoder?.end();
        for (const [provider, session] of sessions.entries()) {
          session.resampler?.end();
          if (!session.closed) {
            closeSession(provider, session);
          }
          await session.cleanupPromise?.catch(() => undefined);
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
