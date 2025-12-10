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

type ChannelLabel = 'mono' | 'L' | 'R';

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
  const pcmQueue: Array<{
    chunk: Buffer;
    meta?: { captureTs: number; durationMs: number; seq: number };
    channel: ChannelLabel;
  }> = [];
  let queuedBytes = 0;
  let sessionStarted = false;
  const channelContexts = new Map<
    ChannelLabel,
    {
      controller: Awaited<ReturnType<typeof adapter.startStreaming>>['controller'];
      resampler: ReturnType<typeof createPcmResampler> | null;
      captureTsQueue: Array<{ captureTs: number; durationMs: number; seq: number }>;
      lastAttributed: { nextTs: number; durationMs: number } | null;
      firstAudioSentAt: number | null;
      lastAudioSentAt: number | null;
      firstCaptureTs: number | null;
      lastCaptureTs: number | null;
    }
  >();
  let normalizer: StreamNormalizer | null = null;
  const sessionId = randomUUID();
  const latencies: number[] = [];
  let lastTranscriptSignature: string | null = null;
  const startedAt = new Date().toISOString();
  let maxQueueBytes = config.ws?.maxPcmQueueBytes ?? 5 * 1024 * 1024;
  let overflowGraceMs = config.ws?.overflowGraceMs ?? 500;
  const keepaliveMs = config.ws?.keepaliveMs ?? 30_000;
  const maxMissedPongs = config.ws?.maxMissedPongs ?? 2;
  let closed = false;
  let expectsPcm = false;
  let sessionDegraded = false;
  let overflowTimer: NodeJS.Timeout | null = null;
  let clientSampleRate = config.audio.targetSampleRate;
  let keepaliveTimer: NodeJS.Timeout | null = null;
  let missedPongs = 0;
  let channelSplit = false;

  const ensureResampler = (label: ChannelLabel, inputSampleRate: number) => {
    const ctx = channelContexts.get(label);
    if (!ctx) return null;
    if (ctx.resampler) return ctx.resampler;
    const created = createPcmResampler({
      inputSampleRate,
      outputSampleRate: providerSampleRate,
      channels: config.audio.targetChannels,
    });
    created.onChunk((chunk, meta) => {
      void flushChunk(chunk, meta, label);
    });
    created.onError((err) => handleFatal(err));
    created.onClose((code) => {
      if (closed) return;
      if (typeof code === 'number' && code !== 0) {
        handleFatal(new Error(`ffmpeg exited with code ${code}`));
      }
    });
    ctx.resampler = created;
    channelContexts.set(label, ctx);
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
      void flushChunk(
        chunk,
        {
          captureTs: Date.now(),
          durationMs: config.audio.chunkMs ?? 250,
          seq: 0,
        },
        'mono'
      );
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
    `${payload.channel}:${payload.speakerId ?? 'unknown'}:${payload.isFinal ? 'final' : 'interim'}:${payload.text}`;

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
    while (pcmQueue.length > 0) {
      const entry = pcmQueue.shift();
      if (!entry) break;
      const ctx = channelContexts.get(entry.channel);
      if (!ctx) continue;
      queuedBytes -= entry.chunk.length;
      if (queuedBytes <= maxQueueBytes && overflowTimer) {
        clearTimeout(overflowTimer);
        overflowTimer = null;
      }
      try {
        const captureTs =
          entry.meta?.captureTs ??
          ctx.lastCaptureTs ??
          ctx.firstCaptureTs ??
          ctx.lastAudioSentAt ??
          ctx.firstAudioSentAt ??
          Date.now();
        await ctx.controller.sendAudio(bufferToArrayBuffer(entry.chunk), { captureTs });
        ctx.captureTsQueue.push({
          captureTs,
          durationMs: entry.meta?.durationMs ?? config.audio.chunkMs ?? 250,
          seq: entry.meta?.seq ?? 0,
        });
        ctx.lastCaptureTs = entry.meta?.captureTs ?? captureTs;
        if (!ctx.firstCaptureTs) ctx.firstCaptureTs = captureTs;
      } catch (err) {
        return handleFatal(err as Error);
      }
      const now = Date.now();
      if (!ctx.firstAudioSentAt) ctx.firstAudioSentAt = now;
      ctx.lastAudioSentAt = now;
      channelContexts.set(entry.channel, ctx);
    }
  }

  const flushChunk = async (
    chunk: Buffer,
    meta: { captureTs: number; durationMs: number; seq: number },
    channel: ChannelLabel
  ) => {
    const ctx = channelContexts.get(channel);
    if (!ctx) {
      pcmQueue.push({ chunk, meta, channel });
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
    const captureTs =
      ctx.lastCaptureTs ?? ctx.firstCaptureTs ?? ctx.lastAudioSentAt ?? ctx.firstAudioSentAt ?? meta.captureTs;
    try {
      await ctx.controller.sendAudio(bufferToArrayBuffer(chunk), { captureTs });
    } catch (err) {
      return handleFatal(err as Error);
    }
    const durationMs = meta?.durationMs ?? config.audio.chunkMs ?? 250;
    const seq = meta?.seq ?? 0;
    ctx.captureTsQueue.push({
      captureTs: meta?.captureTs ?? captureTs,
      durationMs,
      seq,
    });
    ctx.lastCaptureTs = meta?.captureTs ?? captureTs;
    if (!ctx.firstCaptureTs) ctx.firstCaptureTs = ctx.lastCaptureTs;
    const now = Date.now();
    if (!ctx.firstAudioSentAt) ctx.firstAudioSentAt = now;
    ctx.lastAudioSentAt = now;
    channelContexts.set(channel, ctx);
  };

  const handleTranscript = (label: ChannelLabel, transcript: PartialTranscript) => {
    const ctx = channelContexts.get(label);
    if (!ctx) return;
    const attribution =
      ctx.captureTsQueue.shift() ??
      (ctx.lastAttributed
        ? {
            captureTs: ctx.lastAttributed.nextTs,
            durationMs: ctx.lastAttributed.durationMs,
            seq: 0,
          }
        : null);

    if (attribution) {
      ctx.lastAttributed = {
        nextTs: attribution.captureTs + attribution.durationMs,
        durationMs: attribution.durationMs,
      };
    }

    const originCaptureTs =
      attribution?.captureTs ??
      ctx.lastCaptureTs ??
      ctx.firstCaptureTs ??
      ctx.lastAudioSentAt ??
      ctx.firstAudioSentAt ??
      Date.now();

    const latencyMs = Date.now() - originCaptureTs;
    if (typeof latencyMs === 'number') {
      latencies.push(latencyMs);
    }
    const payload: StreamTranscriptMessage = {
      type: 'transcript',
      ...transcript,
      channel: transcript.channel ?? 'mic',
      speakerId: transcript.speakerId ?? (channelSplit ? label : undefined),
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
  };

  function handleFatal(err: Error) {
    if (closed) return;
    closed = true;
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    // Log the error before attempting to send to the client to ensure it lands in realtime-logs.jsonl
    recordLog({ type: 'error', message: err.message, provider });
    sendJson({ type: 'error', message: err.message });
    channelContexts.forEach((ctx) => ctx.resampler?.end());
    transcoder?.end();
    ws.close();
  }

  ws.on('message', (data, isBinary) => {
    void (async () => {
      if (!isBinary) {
        try {
          const parsed = JSON.parse(data.toString()) as { type?: string };
          if (parsed?.type === 'pong') {
            missedPongs = 0;
            return;
          }
        } catch {
          // ignore parse errors for control frames
        }
      }
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
          const isMeetingMode = configMsg.options?.meetingMode === true;
          if (isMeetingMode && config.ws?.meeting) {
            maxQueueBytes = config.ws.meeting.maxPcmQueueBytes ?? maxQueueBytes;
            overflowGraceMs = config.ws.meeting.overflowGraceMs ?? overflowGraceMs;
          }
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
          channelSplit =
            expectsPcm && (configMsg.channelSplit === true || configMsg.options?.enableChannelSplit === true);
          const channelLabels: ChannelLabel[] = channelSplit ? ['L', 'R'] : ['mono'];

          await Promise.all(
            channelLabels.map(async (label) => {
              const streamingSession = await adapter.startStreaming({
                language: lang,
                sampleRateHz: effectivePerProviderTranscode ? providerSampleRate : clientSampleRate,
                encoding: 'linear16',
                enableInterim: configMsg.enableInterim,
                contextPhrases: configMsg.contextPhrases ?? configMsg.options?.dictionaryPhrases,
                punctuationPolicy: configMsg.options?.punctuationPolicy,
                enableVad: configMsg.options?.enableVad,
                enableDiarization: configMsg.options?.enableDiarization,
                dictionaryPhrases: configMsg.options?.dictionaryPhrases,
                normalizePreset: configMsg.normalizePreset,
              });

              channelContexts.set(label, {
                controller: streamingSession.controller,
                resampler: null,
                captureTsQueue: [],
                lastAttributed: null,
                firstAudioSentAt: null,
                lastAudioSentAt: null,
                firstCaptureTs: null,
                lastCaptureTs: null,
              });

              streamingSession.onData((transcript) => handleTranscript(label, transcript));
              streamingSession.onError((err) => {
                recordLog({ type: 'error', message: err.message, provider });
                handleFatal(err);
              });
              streamingSession.onClose(() => {
                ws.close();
              });
            })
          );
          for (const ctx of channelContexts.values()) {
            try {
              await ctx.controller.sendAudio(new ArrayBuffer(0), { captureTs: Date.now() });
            } catch {
              // best effort warm-up for test/mocked controllers
            }
          }
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
              // ignore send failures; close will be handled by ws error handlers
            }
          }, keepaliveMs);
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
        if (sessionStarted && channelContexts.size === 0) {
          pcmQueue.push({
            chunk: buffer,
            meta: { captureTs: Date.now(), durationMs: config.audio.chunkMs ?? 250, seq: 0 },
            channel: 'mono',
          });
          queuedBytes += buffer.length;
          return;
        }
        if (expectsPcm) {
          try {
            const { header, pcm } = parseStreamFrame(buffer);
            const channel: ChannelLabel = channelSplit ? (header.seq % 2 === 0 ? 'L' : 'R') : 'mono';
            const ctx = channelContexts.get(channel);
            if (ctx) {
              ctx.lastCaptureTs = header.captureTs;
              if (!ctx.firstCaptureTs) ctx.firstCaptureTs = header.captureTs;
              channelContexts.set(channel, ctx);
            }
            const durationMs = header.durationMs || config.audio.chunkMs || 250;
            const needsResample = effectivePerProviderTranscode && providerSampleRate !== clientSampleRate;
            if (needsResample) {
              const pipeline = ensureResampler(channel, clientSampleRate);
              await pipeline?.input(pcm, {
                captureTs: header.captureTs,
                durationMs,
                seq: header.seq,
              });
            } else {
              await flushChunk(pcm, {
                captureTs: header.captureTs,
                durationMs,
                seq: header.seq,
              }, channel);
            }
            return;
          } catch (err) {
            return handleFatal(err as Error);
          }
        }
        await flushChunk(
          buffer,
          { captureTs: Date.now(), durationMs: config.audio.chunkMs ?? 250, seq: 0 },
          'mono'
        );
      }
    })();
  });

  ws.on('close', () => {
    void (async () => {
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      transcoder?.end();
      for (const ctx of channelContexts.values()) {
        ctx.resampler?.end();
        await ctx.controller?.end();
        await ctx.controller?.close();
      }
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
