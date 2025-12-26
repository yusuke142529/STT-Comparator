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
  PartialTranscript,
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
    meta: { captureTs: number; durationMs: number; seq: number; inputSampleRate?: number };
    channel: ChannelLabel;
  }> = [];
  let queuedBytes = 0;
  let sessionStarted = false;
  const channelContexts = new Map<
    ChannelLabel,
    {
      controller: Awaited<ReturnType<typeof adapter.startStreaming>>['controller'];
      resampler: ReturnType<typeof createPcmResampler> | null;
      pending: Promise<void> | null;
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
  const compareWs = config.ws?.compare ?? {};
  const backlogSoft = compareWs.backlogSoft ?? 8;
  const backlogHard = compareWs.backlogHard ?? Math.max(backlogSoft * 4, 32);
  const maxDropMs = compareWs.maxDropMs ?? 1000;
  let closed = false;
  let expectsPcm = false;
  let meetingMode = false;
  let sessionDegraded = false;
  let overflowTimer: NodeJS.Timeout | null = null;
  let clientSampleRate = config.audio.targetSampleRate;
  let keepaliveTimer: NodeJS.Timeout | null = null;
  let missedPongs = 0;
  let channelSplit = false;
  let initPromise: Promise<void> | null = null;
  const flushChains = new Map<ChannelLabel, Promise<void>>();
  const backlogCounts = new Map<ChannelLabel, number>();
  const droppedMsByChannel = new Map<ChannelLabel, number>();
  const queueFlush = (label: ChannelLabel, work: () => Promise<void>) => {
    const prev = flushChains.get(label) ?? Promise.resolve();
    const next = prev.then(work).catch((err) => {
      handleFatal(err as Error);
    });
    flushChains.set(label, next);
    return next;
  };

  const scheduleFlush = (
    label: ChannelLabel,
    chunk: Buffer,
    meta: { captureTs: number; durationMs: number; seq: number; inputSampleRate?: number }
  ) => {
    if (closed) return Promise.resolve();
    const currentBacklog = backlogCounts.get(label) ?? 0;
    if (currentBacklog >= backlogHard) {
      handleFatal(new Error('stream send backlog hard limit exceeded'));
      return Promise.resolve();
    }
    if (meetingMode && currentBacklog >= backlogSoft) {
      const durationMs = meta.durationMs ?? config.audio.chunkMs ?? 250;
      const dropped = (droppedMsByChannel.get(label) ?? 0) + durationMs;
      droppedMsByChannel.set(label, dropped);
      sessionDegraded = true;
      if (dropped > maxDropMs) {
        handleFatal(new Error('stream backlog drop budget exceeded'));
        return Promise.resolve();
      }
      if (dropped === durationMs) {
        logger.warn({
          event: 'pcm_drop_started',
          provider,
          channel: label,
          backlogSoft,
          backlogHard,
          maxDropMs,
        });
      }
      return Promise.resolve();
    }

    backlogCounts.set(label, currentBacklog + 1);
    return queueFlush(label, async () => {
      try {
        await flushChunk(chunk, meta, label);
      } finally {
        const nextCount = Math.max(0, (backlogCounts.get(label) ?? 1) - 1);
        backlogCounts.set(label, nextCount);
        if (meetingMode && nextCount < backlogSoft && (droppedMsByChannel.get(label) ?? 0) > 0) {
          droppedMsByChannel.set(label, 0);
          logger.info({ event: 'pcm_drop_recovered', provider, channel: label });
        }
      }
    });
  };

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
      void scheduleFlush(label, chunk, {
        captureTs: meta.captureTs,
        durationMs: meta.durationMs,
        seq: meta.seq ?? 0,
      });
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
      void scheduleFlush('mono', chunk, {
        captureTs: Date.now(),
        durationMs: config.audio.chunkMs ?? 250,
        seq: 0,
      });
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
      const entry = pcmQueue[0];
      if (!entry) break;
      // Defer until the corresponding streaming session is ready.
      if (!channelContexts.get(entry.channel)) break;

      pcmQueue.shift();
      queuedBytes -= entry.chunk.length;
      if (queuedBytes <= maxQueueBytes && overflowTimer) {
        clearTimeout(overflowTimer);
        overflowTimer = null;
      }

      const needsResample =
        effectivePerProviderTranscode &&
        providerSampleRate !== (entry.meta.inputSampleRate ?? providerSampleRate);
      if (needsResample) {
        const pipeline = ensureResampler(entry.channel, entry.meta.inputSampleRate ?? clientSampleRate);
        if (!pipeline) {
          // Shouldn't happen once channelContexts is ready, but avoid dropping.
          pcmQueue.unshift(entry);
          queuedBytes += entry.chunk.length;
          break;
        }
        await pipeline.input(entry.chunk, {
          captureTs: entry.meta.captureTs,
          durationMs: entry.meta.durationMs,
          seq: entry.meta.seq,
        });
        continue;
      }

      await scheduleFlush(entry.channel, entry.chunk, entry.meta);
    }
  }

  const flushChunk = async (
    chunk: Buffer,
    meta: { captureTs: number; durationMs: number; seq: number; inputSampleRate?: number },
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
    const attributedCaptureTs =
      Number.isFinite(meta.captureTs) && meta.captureTs > 0
        ? meta.captureTs
        : ctx.lastCaptureTs ?? ctx.firstCaptureTs ?? ctx.lastAudioSentAt ?? ctx.firstAudioSentAt ?? Date.now();
    const durationMs = meta?.durationMs ?? config.audio.chunkMs ?? 250;
    const seq = meta?.seq ?? 0;

    // Record attribution before sending so ultra-fast/mock adapters can emit transcripts synchronously.
    ctx.captureTsQueue.push({
      captureTs: attributedCaptureTs,
      durationMs,
      seq,
    });
    ctx.lastCaptureTs = attributedCaptureTs;
    if (!ctx.firstCaptureTs) ctx.firstCaptureTs = attributedCaptureTs;
    const now = Date.now();
    if (!ctx.firstAudioSentAt) ctx.firstAudioSentAt = now;
    ctx.lastAudioSentAt = now;
    channelContexts.set(channel, ctx);

    const sendPromise = (ctx.pending ?? Promise.resolve())
      .then(async () => {
        await ctx.controller.sendAudio(bufferToArrayBuffer(chunk), { captureTs: attributedCaptureTs });
      })
      .catch((err) => {
        handleFatal(err as Error);
      });
    ctx.pending = sendPromise;
    channelContexts.set(channel, ctx);
    await sendPromise;
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

    const rawLatencyMs = Date.now() - originCaptureTs;
    const latencyMs = Number.isFinite(rawLatencyMs) && rawLatencyMs >= 0 ? rawLatencyMs : undefined;
    const payload: StreamTranscriptMessage = {
      type: 'transcript',
      ...transcript,
      channel: transcript.channel ?? 'mic',
      speakerId: transcript.speakerId ?? (channelSplit ? label : undefined),
      latencyMs,
      originCaptureTs: Number.isFinite(originCaptureTs) ? originCaptureTs : undefined,
      degraded: sessionDegraded,
    };
    if (payload.isFinal && latencyMs !== undefined) latencies.push(latencyMs);
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
    if (overflowTimer) {
      clearTimeout(overflowTimer);
      overflowTimer = null;
    }
    // Log the error before attempting to send to the client to ensure it lands in realtime-logs.jsonl
    recordLog({ type: 'error', message: err.message, provider });
    sendJson({ type: 'error', message: err.message });
    channelContexts.forEach((ctx) => ctx.resampler?.end());
    transcoder?.end();
    ws.close();
  }

  const sanitizeCaptureTs = (candidate: number, fallback: number) => {
    if (!Number.isFinite(candidate) || candidate <= 0) return fallback;
    const now = Date.now();
    return candidate > now ? now : candidate;
  };
  const sanitizeDurationMs = (candidate: number, fallback: number) => {
    if (!Number.isFinite(candidate) || candidate <= 0) return fallback;
    return Math.min(candidate, 5_000);
  };

  ws.on('message', (data, isBinary) => {
    if (closed) return;

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

    if (closed) return;

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
        meetingMode = configMsg.options?.meetingMode === true;
        if (meetingMode && config.ws?.meeting) {
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

        initPromise = (async () => {
          await Promise.all(
            channelLabels.map(async (label) => {
              const streamingSession = await adapter.startStreaming({
                language: lang,
                sampleRateHz: effectivePerProviderTranscode ? providerSampleRate : clientSampleRate,
                encoding: 'linear16',
                enableInterim: configMsg.enableInterim,
                contextPhrases: configMsg.contextPhrases ?? configMsg.options?.dictionaryPhrases,
                punctuationPolicy: configMsg.options?.punctuationPolicy,
                enableVad: configMsg.options?.enableVad ?? false,
                enableDiarization: configMsg.options?.enableDiarization,
                dictionaryPhrases: configMsg.options?.dictionaryPhrases,
                normalizePreset: configMsg.normalizePreset,
              });

              channelContexts.set(label, {
                controller: streamingSession.controller,
                resampler: null,
                pending: null,
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
        })();
        void initPromise.catch((err) => handleFatal(err as Error));
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid initial config message';
        sendJson({ type: 'error', message });
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
        const channel: ChannelLabel = channelSplit ? (header.seq % 2 === 0 ? 'L' : 'R') : 'mono';
        const baseDuration = config.audio.chunkMs ?? 250;
        const captureTs = sanitizeCaptureTs(header.captureTs, Date.now());
        const durationMs = sanitizeDurationMs(header.durationMs || baseDuration, baseDuration);
        const needsResample = effectivePerProviderTranscode && providerSampleRate !== clientSampleRate;

          if (needsResample) {
            const pipeline = ensureResampler(channel, clientSampleRate);
            if (pipeline) {
              void pipeline
                .input(pcm, { captureTs, durationMs, seq: header.seq })
                .catch((err) => handleFatal(err as Error));
            } else {
              void scheduleFlush(channel, pcm, {
                captureTs,
                durationMs,
                seq: header.seq,
                inputSampleRate: clientSampleRate,
              });
            }
            return;
          }

          void scheduleFlush(channel, pcm, { captureTs, durationMs, seq: header.seq });
          return;
        } catch (err) {
          handleFatal(err as Error);
          return;
        }
    }

    const activeTranscoder = ensureTranscoder();
    if (!activeTranscoder) return;
    void activeTranscoder.input(buffer).catch((err) => handleFatal(err as Error));
  });

  ws.on('close', () => {
    void (async () => {
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      if (overflowTimer) {
        clearTimeout(overflowTimer);
        overflowTimer = null;
      }
      transcoder?.end();
      for (const ctx of channelContexts.values()) {
        ctx.resampler?.end();
        await ctx.controller?.end().catch(() => undefined);
        await ctx.controller?.close().catch(() => undefined);
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
    })().catch((error) => {
      logger.error({ event: 'ws_close_error', message: (error as Error).message });
    });
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
