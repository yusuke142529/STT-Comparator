import type { WebSocket, RawData } from 'ws';
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
  RealtimeLogPayload,
  RealtimeLatencySummary,
  RealtimeTranscriptLogEntry,
  StreamingConfigMessage,
  StreamErrorMessage,
  StreamTranscriptMessage,
  StreamSessionMessage,
  StorageDriver,
  NormalizedTranscriptMessage,
} from '../types.js';
import type { RealtimeTranscriptLogWriter } from '../storage/realtimeTranscriptStore.js';

export async function handleStreamConnection(
  ws: WebSocket,
  provider: ProviderId,
  lang: string,
  latencyStore: StorageDriver<RealtimeLatencySummary>,
  logStore?: RealtimeTranscriptLogWriter
) {
  const config = await loadConfig();
  const providerSampleRate = getProviderSampleRate(provider, config);
  const providerAudioConfig = { ...config.audio, targetSampleRate: providerSampleRate };
  const perProviderTranscode = isPerProviderTranscodeEnabled();
  const forcedPerProviderTranscode = requiresHighQualityTranscode(provider);
  const effectivePerProviderTranscode = perProviderTranscode || forcedPerProviderTranscode;
  const adapter = getAdapter(provider);
  let transcoder: ReturnType<typeof spawnPcmTranscoder> | null = null;
  let resampler: ReturnType<typeof createPcmResampler> | null = null;
  const pcmQueue: Array<{ chunk: Buffer; meta?: { captureTs: number; durationMs: number; seq: number } }> = [];
  let queuedBytes = 0;
  let sessionStarted = false;
  let controller: Awaited<ReturnType<typeof adapter.startStreaming>>['controller'] | null = null;
  let firstAudioSentAt: number | null = null;
  let lastAudioSentAt: number | null = null;
  let firstCaptureTs: number | null = null;
  let lastCaptureTs: number | null = null;
  let normalizer: StreamNormalizer | null = null;
  const captureTsQueue: Array<{ captureTs: number; durationMs: number; seq: number }> = [];
  let lastAttributed: { nextTs: number; durationMs: number } | null = null;
  const sessionId = randomUUID();
  const latencies: number[] = [];
  let lastTranscriptSignature: string | null = null;
  const startedAt = new Date().toISOString();
  const maxQueueBytes = config.ws?.maxPcmQueueBytes ?? 5 * 1024 * 1024;
  const overflowGraceMs = config.ws?.overflowGraceMs ?? 500;
  let closed = false;
  let expectsPcm = false;
  let sessionDegraded = false;
  let overflowTimer: NodeJS.Timeout | null = null;
  let clientSampleRate = config.audio.targetSampleRate;

  const ensureResampler = (inputSampleRate: number) => {
    if (resampler) return resampler;
    const created = createPcmResampler({
      inputSampleRate,
      outputSampleRate: providerSampleRate,
      channels: config.audio.targetChannels,
    });
    created.onChunk((chunk, meta) => {
      void flushChunk(chunk, meta);
    });
    created.onError((err) => handleFatal(err));
    created.onClose((code) => {
      if (closed) return;
      if (typeof code === 'number' && code !== 0) {
        handleFatal(new Error(`ffmpeg exited with code ${code}`));
      }
    });
    resampler = created;
    return created;
  };
  const ensureTranscoder = () => {
    if (expectsPcm) {
      return null;
    }
    if (transcoder) return transcoder;
    const spawned = spawnPcmTranscoder(providerAudioConfig);
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

  function sendJson(
    payload: StreamTranscriptMessage | NormalizedTranscriptMessage | StreamErrorMessage | StreamSessionMessage
  ) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // even if the socket is closed, still persist the log for diagnostics
    } finally {
      recordLog(payload);
    }
  }

  async function flushQueue() {
    if (!controller) return;
    while (pcmQueue.length > 0) {
      const entry = pcmQueue.shift();
      if (!entry) break;
      queuedBytes -= entry.chunk.length;
      if (queuedBytes <= maxQueueBytes && overflowTimer) {
        clearTimeout(overflowTimer);
        overflowTimer = null;
      }
      try {
        const captureTs = entry.meta?.captureTs ?? lastCaptureTs ?? firstCaptureTs ?? Date.now();
        await controller.sendAudio(bufferToArrayBuffer(entry.chunk), { captureTs });
        captureTsQueue.push({
          captureTs,
          durationMs: entry.meta?.durationMs ?? config.audio.chunkMs ?? 250,
          seq: entry.meta?.seq ?? 0,
        });
      } catch (err) {
        return handleFatal(err as Error);
      }
      const now = Date.now();
      if (!firstAudioSentAt) firstAudioSentAt = now;
      lastAudioSentAt = now;
    }
  }

  const flushChunk = async (
    chunk: Buffer,
    meta?: { captureTs: number; durationMs: number; seq: number }
  ) => {
    if (!controller) {
      pcmQueue.push({ chunk, meta });
      queuedBytes += chunk.length;
      if (queuedBytes > maxQueueBytes && !overflowTimer) {
        overflowTimer = setTimeout(() => {
          if (queuedBytes > maxQueueBytes) {
            handleFatal(
              new Error(
                `audio buffer backlog exceeded ${Math.round(maxQueueBytes / 1024)}KB; reduce input rate or chunk size`
              )
            );
          } else {
            overflowTimer = null;
          }
        }, overflowGraceMs);
        logger.warn({
          event: 'pcm_queue_backlog',
          queuedBytes,
          maxQueueBytes,
          graceMs: overflowGraceMs,
        });
      }
      return;
    }
    const captureTs = lastCaptureTs ?? firstCaptureTs ?? Date.now();
    try {
      await controller.sendAudio(bufferToArrayBuffer(chunk), { captureTs });
    } catch (err) {
      return handleFatal(err as Error);
    }
    const durationMs = meta?.durationMs ?? config.audio.chunkMs ?? 250;
    const seq = meta?.seq ?? 0;
    captureTsQueue.push({
      captureTs: meta?.captureTs ?? captureTs,
      durationMs,
      seq,
    });
    const now = Date.now();
    if (!firstAudioSentAt) firstAudioSentAt = now;
    lastAudioSentAt = now;
  };

  function handleFatal(err: Error) {
    if (closed) return;
    closed = true;
    // Log the error before attempting to send to the client to ensure it lands in realtime-logs.jsonl
    recordLog({ type: 'error', message: err.message, provider });
    sendJson({ type: 'error', message: err.message });
    resampler?.end();
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
          normalizer = new StreamNormalizer({
            bucketMs: config.audio.chunkMs ?? 250,
            preset: configMsg.normalizePreset,
            sessionId,
          });
          // clientSampleRate is required for pcm=true; schema enforces this, but keep a defensive check.
          clientSampleRate = expectsPcm
            ? configMsg.clientSampleRate ?? providerSampleRate
            : configMsg.clientSampleRate ?? providerSampleRate;

          logger.info({
            event: 'stream_session_start',
            provider,
            lang,
            clientSampleRate,
            effectiveSampleRate: providerSampleRate,
            perProviderTranscode: effectivePerProviderTranscode,
            forcedPerProviderTranscode,
          });

          sendJson({
            type: 'session',
            sessionId,
            provider,
            startedAt,
            inputSampleRate: clientSampleRate,
            audioSpec: { sampleRate: providerSampleRate, channels: 1, format: 'pcm16le' },
          });
          const streamingSession = await adapter.startStreaming({
            language: lang,
            sampleRateHz: effectivePerProviderTranscode ? providerSampleRate : clientSampleRate,
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
            const attribution =
              captureTsQueue.shift() ??
              (lastAttributed
                ? {
                    captureTs: lastAttributed.nextTs,
                    durationMs: lastAttributed.durationMs,
                    seq: 0,
                  }
                : null);

            if (attribution) {
              lastAttributed = {
                nextTs: attribution.captureTs + attribution.durationMs,
                durationMs: attribution.durationMs,
              };
            }

            const originCaptureTs =
              attribution?.captureTs ??
              lastCaptureTs ??
              firstCaptureTs ??
              lastAudioSentAt ??
              firstAudioSentAt ??
              Date.now();

            const latencyMs = Date.now() - originCaptureTs;
            if (typeof latencyMs === 'number') {
              latencies.push(latencyMs);
            }
            const payload: StreamTranscriptMessage = {
              type: 'transcript',
              ...transcript,
              channel: transcript.channel ?? 'mic',
              latencyMs,
              originCaptureTs: originCaptureTs ?? undefined,
              degraded: sessionDegraded,
            };
            if (!shouldEmitTranscript(payload)) {
              return;
            }
            const normalized = normalizer?.ingest(provider, {
              provider,
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
            sendJson(payload);
            if (normalized) {
              const normalizedMsg: NormalizedTranscriptMessage = {
                type: 'normalized',
                ...normalized,
              };
              sendJson(normalizedMsg);
            }
          });
          streamingSession.onError((err) => {
            // Persist API/WS error details for later triage
            recordLog({ type: 'error', message: err.message, provider });
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
          try {
            const { header, pcm } = parseStreamFrame(buffer);
            lastCaptureTs = header.captureTs;
            if (!firstCaptureTs) firstCaptureTs = header.captureTs;
            const durationMs = header.durationMs || config.audio.chunkMs || 250;
            const needsResample = effectivePerProviderTranscode && providerSampleRate !== clientSampleRate;
            if (needsResample) {
              const pipeline = ensureResampler(clientSampleRate);
              await pipeline.input(pcm, {
                captureTs: header.captureTs,
                durationMs,
                seq: header.seq,
              });
            } else {
              await flushChunk(pcm, {
                captureTs: header.captureTs,
                durationMs,
                seq: header.seq,
              });
            }
            return;
          } catch (err) {
            return handleFatal(err as Error);
          }
        }
        const activeTranscoder = ensureTranscoder();
        await activeTranscoder.input(buffer);
      }
    })();
  });

  ws.on('close', () => {
    void (async () => {
      resampler?.end();
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
    handleFatal(err);
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
