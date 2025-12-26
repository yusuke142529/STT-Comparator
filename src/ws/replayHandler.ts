import { spawn } from 'node:child_process';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { loadConfig } from '../config.js';
import { getAdapter } from '../adapters/index.js';
import { logger } from '../logger.js';
import { bufferToArrayBuffer } from '../utils/buffer.js';
import { persistLatency } from '../utils/latency.js';
import { streamingConfigMessageSchema } from '../validation.js';
import { StreamNormalizer } from './streamNormalizer.js';
import {
  getProviderSampleRate,
  isPerProviderTranscodeEnabled,
  requiresHighQualityTranscode,
} from '../utils/providerAudio.js';
import WebSocket from 'ws';
import type { WebSocket as WsType } from 'ws';
import type {
  ProviderId,
  RealtimeLatencySummary,
  RealtimeLogPayload,
  RealtimeTranscriptLogEntry,
  NormalizedTranscriptMessage,
  StreamTranscriptMessage,
  StreamingConfigMessage,
  StreamingController,
  StorageDriver,
} from '../types.js';
import type { ReplaySessionStore } from '../replay/replaySessionStore.js';
import type { RealtimeTranscriptLogWriter } from '../storage/realtimeTranscriptStore.js';

const buildFileTranscoderArgs = (filePath: string, sampleRate: number, channels: number) => [
  '-nostdin',
  '-hide_banner',
  // Relaxed decode to avoid aborting on mildly corrupt files during replay
  '-v',
  'warning',
  '-fflags',
  '+discardcorrupt',
  '-err_detect',
  'ignore_err',
  '-re',
  '-i',
  filePath,
  '-vn',
  '-sn',
  '-dn',
  '-ac',
  String(channels),
  '-ar',
  String(sampleRate),
  '-f',
  's16le',
  'pipe:1',
];

type FileTranscoder = {
  stream: NodeJS.ReadableStream;
  stop: () => void;
  onError: (cb: (err: Error) => void) => void;
  onClose: (cb: (code: number | null) => void) => void;
  exitCode?: number | null;
};

function spawnFileTranscoder(filePath: string, sampleRate: number, channels: number): FileTranscoder {
  const proc = spawn(ffmpegInstaller.path, buildFileTranscoderArgs(filePath, sampleRate, channels), {
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  const stop = () => {
    if (!proc.killed) {
      proc.kill('SIGINT');
    }
  };

  return {
    stream: proc.stdout,
    stop,
    onError: (cb) => proc.once('error', cb),
    onClose: (cb) => proc.once('close', cb),
  };
}

function takeAttribution(
  queue: Array<{ captureTs: number; durationMs: number }>,
  last: { nextTs: number; durationMs: number } | null,
  fallbackTs?: number
): { originCaptureTs: number; next: { nextTs: number; durationMs: number } | null } {
  const attribution =
    queue.shift() ??
    (last
      ? {
          captureTs: last.nextTs,
          durationMs: last.durationMs,
        }
      : null);

  if (attribution) {
    return {
      originCaptureTs: attribution.captureTs,
      next: {
        nextTs: attribution.captureTs + attribution.durationMs,
        durationMs: attribution.durationMs,
      },
    };
  }

  const fallback = typeof fallbackTs === 'number' ? fallbackTs : Date.now();
  return { originCaptureTs: fallback, next: last };
}

export async function handleReplayConnection(
  ws: WsType,
  provider: ProviderId,
  lang: string,
  sessionId: string,
  sessionStore: ReplaySessionStore,
  latencyStore?: StorageDriver<RealtimeLatencySummary>,
  logStore?: RealtimeTranscriptLogWriter
) {
  const config = await loadConfig();
  const globalPerProviderTranscode = isPerProviderTranscodeEnabled();
  const forcedPerProviderTranscode = requiresHighQualityTranscode(provider);
  const perProviderTranscode = globalPerProviderTranscode || forcedPerProviderTranscode;
  const targetSampleRate = perProviderTranscode
    ? getProviderSampleRate(provider, config)
    : config.audio.targetSampleRate;
  const replaySession = sessionStore.take(sessionId);
  if (!replaySession) {
    ws.send(JSON.stringify({ type: 'error', message: 'replay session not found or already consumed' }));
    ws.close();
    return;
  }
  if (!replaySession.providers.includes(provider)) {
    ws.send(JSON.stringify({ type: 'error', message: 'provider mismatch for replay session' }));
    ws.close();
    await sessionStore.cleanup(sessionId);
    return;
  }

  const adapter = getAdapter(provider);
  const startedAt = new Date().toISOString();
  let controller: StreamingController | null = null;
  let fileTranscoder: FileTranscoder | null = null;
  const latencies: number[] = [];
  let firstAudioSentAt: number | null = null;
  let lastAudioSentAt: number | null = null;
  const captureTsQueue: Array<{ captureTs: number; durationMs: number }> = [];
  let lastAttributed: { nextTs: number; durationMs: number } | null = null;
  let closed = false;
  let configApplied = false;
  let pcmBytes = 0;
  let normalizer: StreamNormalizer | null = null;
  const replayConfig = config.ws?.replay ?? {};
  const minReplayDurationMs = replayConfig.minDurationMs ?? 100;

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
      .catch((error) => logger.error({ event: 'replay_realtime_log_error', message: error.message }));
  };

  const sendJson = (
    payload:
      | StreamTranscriptMessage
      | NormalizedTranscriptMessage
      | { type: 'session'; [key: string]: unknown }
      | { type: 'error'; message: string }
  ) => {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // socket may already be closed; still log for diagnostics
    } finally {
      recordLog(payload as RealtimeLogPayload);
    }
  };

  const handleFatal = (error: Error) => {
    if (closed) return;
    closed = true;
    logger.error({ event: 'replay_fatal', provider, message: error.message });
    // Ensure error details are persisted to realtime-logs.jsonl
    recordLog({ type: 'error', message: error.message, provider } as RealtimeLogPayload);
    sendJson({ type: 'error', message: error.message });
    fileTranscoder?.stop();
    ws.close();
  };

  const attachPlayback = async (configMsg: StreamingConfigMessage) => {
    try {
      normalizer = new StreamNormalizer({
        bucketMs: config.audio.chunkMs ?? 250,
        preset: configMsg.normalizePreset,
        sessionId,
      });
      sendJson({
        type: 'session',
        sessionId,
        provider,
        startedAt,
        inputSampleRate: config.audio.targetSampleRate,
        audioSpec: { sampleRate: targetSampleRate, channels: 1, format: 'pcm16le' },
      });
      logger.info({
        event: 'replay_start_streaming',
        provider,
        lang,
        targetSampleRate,
        degraded: !!configMsg.degraded,
      });
      const streamingSession = await adapter.startStreaming({
        language: lang,
        sampleRateHz: targetSampleRate,
        encoding: 'linear16',
        enableInterim: configMsg.enableInterim,
        contextPhrases: configMsg.contextPhrases ?? configMsg.options?.dictionaryPhrases,
        punctuationPolicy: configMsg.options?.punctuationPolicy,
        enableVad: configMsg.options?.enableVad ?? false,
        enableDiarization: configMsg.options?.enableDiarization,
        dictionaryPhrases: configMsg.options?.dictionaryPhrases,
        normalizePreset: configMsg.normalizePreset,
      });

      controller = streamingSession.controller;

      streamingSession.onData((transcript) => {
        const fallbackTs = lastAudioSentAt ?? firstAudioSentAt ?? undefined;
        const { originCaptureTs, next } = takeAttribution(captureTsQueue, lastAttributed, fallbackTs);
        lastAttributed = next;

        const latencyMs = Date.now() - originCaptureTs;
        if (typeof latencyMs === 'number') latencies.push(latencyMs);
        const payload: StreamTranscriptMessage = {
          ...transcript,
          type: 'transcript',
          channel: 'file',
          latencyMs,
          originCaptureTs: originCaptureTs ?? undefined,
        };
        sendJson(payload);
        const normalized = normalizer?.ingest(provider, {
          provider,
          isFinal: payload.isFinal,
          text: payload.text,
          words: payload.words,
          timestamp: originCaptureTs ?? payload.timestamp ?? Date.now(),
          channel: 'file',
          latencyMs: payload.latencyMs,
          originCaptureTs: originCaptureTs ?? undefined,
          confidence: payload.confidence,
          punctuationApplied: payload.punctuationApplied,
          casingApplied: payload.casingApplied,
        });
        if (normalized) {
          const normalizedMsg: NormalizedTranscriptMessage = { type: 'normalized', ...normalized };
          sendJson(normalizedMsg);
        }
      });

      streamingSession.onError(handleFatal);
      streamingSession.onClose(() => {
        ws.close();
      });

      fileTranscoder = spawnFileTranscoder(replaySession.filePath, targetSampleRate, config.audio.targetChannels);
      logger.info({
        event: 'replay_transcoder_spawned',
        provider,
        file: replaySession.filePath,
        targetSampleRate,
        channels: config.audio.targetChannels,
      });

      fileTranscoder.onError(handleFatal);
      fileTranscoder.onClose((code) => {
        void (async () => {
          const minBytes = Math.ceil(
            targetSampleRate * config.audio.targetChannels * 2 * (minReplayDurationMs / 1000)
          );
          if (code !== 0) {
            handleFatal(new Error(`ffmpeg exited with code ${code ?? 'unknown'}`));
            return;
          }
          if (pcmBytes < minBytes) {
            handleFatal(
              new Error(
                `audio decoding produced almost no PCM samples (<${minReplayDurationMs}ms); unsupported codec or too-short clip?`
              )
            );
            return;
          }
          try {
            await controller?.end();
          } catch (err) {
            console.error('failed to end controller', err);
          }
        })();
      });

      const pump = async (chunk: Buffer) => {
        if (!controller) return;
        const captureTs = Date.now();
        const samples = chunk.length / (2 * config.audio.targetChannels);
        const durationMs = (samples / targetSampleRate) * 1000;
        fileTranscoder?.stream.pause();
        try {
          await controller.sendAudio(bufferToArrayBuffer(chunk), { captureTs });
        } catch (err) {
          handleFatal(err as Error);
          return;
        } finally {
          fileTranscoder?.stream.resume();
        }
        pcmBytes += chunk.length;
        const now = Date.now();
        if (!firstAudioSentAt) firstAudioSentAt = now;
        lastAudioSentAt = now;
        captureTsQueue.push({ captureTs, durationMs });
      };

      fileTranscoder.stream.on('data', (chunk: Buffer) => {
        void pump(chunk);
      });
      fileTranscoder.stream.on('end', () => {
        void (async () => {
          try {
            await controller?.end();
          } catch (err) {
            handleFatal(err as Error);
          }
        })();
      });
    } catch (error) {
      handleFatal(error as Error);
    }
  };

  ws.on('message', (data, isBinary) => {
    if (configApplied) return;
    if (isBinary) {
      handleFatal(new Error('binary payloads are not supported for replay'));
      return;
    }
    void (async () => {
      try {
        const parsed = JSON.parse(data.toString());
        const configMsg = streamingConfigMessageSchema.parse(parsed) as StreamingConfigMessage;
        configApplied = true;
        await attachPlayback(configMsg);
      } catch (err) {
        handleFatal(err as Error);
      }
    })();
  });

  ws.on('error', (err) => {
    handleFatal(err as Error);
  });

  ws.on('close', (code, reason) => {
    logger.info({
      event: 'replay_ws_close',
      provider,
      code,
      reason: reason?.toString(),
    });
    void (async () => {
      fileTranscoder?.stop();
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
      ).catch(() => undefined);
      await sessionStore.cleanup(sessionId);
      recordLog({ type: 'session_end', endedAt: new Date().toISOString() });
    })().catch((error) => {
      logger.error({ event: 'replay_ws_close_error', provider, message: (error as Error).message });
    });
  });
}

type MultiProviderSession = {
  controller: StreamingController;
  latencies: number[];
  captureTsQueue: Array<{ captureTs: number; durationMs: number }>;
  lastTranscriptSignature: string | null;
  lastAttributed?: { nextTs: number; durationMs: number };
};

export async function handleReplayMultiConnection(
  ws: WsType,
  providers: ProviderId[],
  lang: string,
  sessionId: string,
  sessionStore: ReplaySessionStore,
  latencyStore?: StorageDriver<RealtimeLatencySummary>,
  logStore?: RealtimeTranscriptLogWriter
) {
  const config = await loadConfig();
  const globalPerProviderTranscode = isPerProviderTranscodeEnabled();
  const replaySession = sessionStore.take(sessionId);
  if (!replaySession) {
    ws.send(JSON.stringify({ type: 'error', message: 'replay session not found or already consumed' }));
    ws.close();
    return;
  }
  // Validate session providers overlap with requested list
  const missing = providers.filter((p) => !replaySession.providers.includes(p));
  if (missing.length > 0) {
    ws.send(JSON.stringify({ type: 'error', message: 'provider mismatch for replay session' }));
    ws.close();
    await sessionStore.cleanup(sessionId);
    return;
  }

  const sessions = new Map<ProviderId, MultiProviderSession>();
  const adapters = providers.map((id) => ({ id, adapter: getAdapter(id) }));
  const startedAt = new Date().toISOString();
  const fileTranscoders = new Map<ProviderId, FileTranscoder>();
  let closed = false;
  let configApplied = false;
  let normalizer: StreamNormalizer | null = null;

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
      .catch((error) => logger.error({ event: 'replay_realtime_log_error', message: error.message }));
  };

  const sendJson = (
    payload:
      | StreamTranscriptMessage
      | NormalizedTranscriptMessage
      | { type: 'session'; [key: string]: unknown }
      | { type: 'error'; message: string },
    provider: ProviderId | null = null
  ) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
    recordLog(provider, payload as RealtimeLogPayload);
  };

  const handleFatal = (error: Error) => {
    if (closed) return;
    closed = true;
    sendJson({ type: 'error', message: error.message });
    for (const transcoder of fileTranscoders.values()) {
      transcoder.stop();
    }
    ws.close();
  };

  const buildTranscriptSignature = (provider: ProviderId, payload: StreamTranscriptMessage): string =>
    `${provider}:${payload.channel}:${payload.isFinal ? 'final' : 'interim'}:${payload.text}`;

  const shouldEmitTranscript = (provider: ProviderId, payload: StreamTranscriptMessage): boolean => {
    const signature = buildTranscriptSignature(provider, payload);
    const session = sessions.get(provider);
    if (!session) return false;
    if (session.lastTranscriptSignature === signature) return false;
    session.lastTranscriptSignature = signature;
    return true;
  };

  const wireTranscoder = (
    provider: ProviderId,
    session: MultiProviderSession,
    sampleRate: number,
    channels: number,
    sourceFile: string
  ) => {
    const transcoder = spawnFileTranscoder(sourceFile, sampleRate, channels);
    fileTranscoders.set(provider, transcoder);

    transcoder.onError(handleFatal);
    transcoder.onClose((code) => {
      void (async () => {
        if (code !== 0) {
          handleFatal(new Error(`ffmpeg exited with code ${code ?? 'unknown'}`));
          return;
        }
        try {
          await session.controller.end().catch(() => undefined);
        } finally {
          /* noop */
        }
      })();
    });

    transcoder.stream.on('data', (chunk: Buffer) => {
      const captureTs = Date.now();
      const samples = chunk.length / (2 * channels);
      const durationMs = (samples / sampleRate) * 1000;
      session.captureTsQueue.push({ captureTs, durationMs });
      void session.controller.sendAudio(bufferToArrayBuffer(chunk), { captureTs }).catch((err) => {
        logger.warn({ event: 'replay_multi_send_error', provider, message: (err as Error).message });
        handleFatal(err as Error);
      });
    });
  };

  const attachPlayback = async (configMsg: StreamingConfigMessage) => {
    try {
      normalizer = new StreamNormalizer({
        bucketMs: config.audio.chunkMs ?? 250,
        preset: configMsg.normalizePreset,
        sessionId,
      });

      for (const { id, adapter } of adapters) {
        const forcedPerProviderTranscode = requiresHighQualityTranscode(id);
        const providerPerProviderTranscode = globalPerProviderTranscode || forcedPerProviderTranscode;
        const providerSampleRate = providerPerProviderTranscode
          ? getProviderSampleRate(id, config)
          : config.audio.targetSampleRate;
        const streamingSession = await adapter.startStreaming({
          language: lang,
          sampleRateHz: providerSampleRate,
          encoding: 'linear16',
          enableInterim: configMsg.enableInterim,
          contextPhrases: configMsg.contextPhrases ?? configMsg.options?.dictionaryPhrases,
          punctuationPolicy: configMsg.options?.punctuationPolicy,
          enableVad: configMsg.options?.enableVad ?? false,
          enableDiarization: configMsg.options?.enableDiarization,
          dictionaryPhrases: configMsg.options?.dictionaryPhrases,
          normalizePreset: configMsg.normalizePreset,
        });

        const providerSession: MultiProviderSession = {
          controller: streamingSession.controller,
          latencies: [],
          captureTsQueue: [],
          lastTranscriptSignature: null,
          lastAttributed: undefined,
        };
        sessions.set(id, providerSession);

        streamingSession.onData((transcript) => {
          const session = sessions.get(id);
          if (!session) return;
          const { originCaptureTs, next } = takeAttribution(
            session.captureTsQueue,
            session.lastAttributed ?? null
          );
          session.lastAttributed = next ?? undefined;

          const latencyMs = Date.now() - originCaptureTs;
          if (typeof latencyMs === 'number') session.latencies.push(latencyMs);
          const payload: StreamTranscriptMessage = {
            ...transcript,
            type: 'transcript',
            provider: transcript.provider ?? id,
            channel: 'file',
            latencyMs,
            originCaptureTs: originCaptureTs ?? undefined,
          };
          if (!shouldEmitTranscript(id, payload)) return;
          const normalized = normalizer?.ingest(id, {
            provider: id,
            isFinal: payload.isFinal,
            text: payload.text,
            words: payload.words,
            timestamp: originCaptureTs ?? payload.timestamp ?? Date.now(),
            channel: 'file',
            latencyMs: payload.latencyMs,
            originCaptureTs: originCaptureTs ?? undefined,
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

        streamingSession.onError((err) => handleFatal(err));
        streamingSession.onClose(() => {
          // Treat provider-initiated close as normal; overall ws close is driven by file playback completion.
        });

        sendJson(
          {
            type: 'session',
            sessionId,
            provider: id,
            startedAt,
            inputSampleRate: config.audio.targetSampleRate,
            audioSpec: { sampleRate: providerSampleRate, channels: 1, format: 'pcm16le' },
          },
          id
        );
      }

      // Start per-provider transcoders so each receives its preferred sample rate.
      for (const [id, session] of sessions.entries()) {
        const forcePerProvider = requiresHighQualityTranscode(id);
        const rate = (globalPerProviderTranscode || forcePerProvider)
          ? getProviderSampleRate(id, config)
          : config.audio.targetSampleRate;
        wireTranscoder(id, session, rate, config.audio.targetChannels, replaySession.filePath);
      }
    } catch (error) {
      logger.error({
        event: 'replay_attach_error',
        providers: Array.from(sessions.keys()),
        message: error instanceof Error ? error.message : String(error),
      });
      handleFatal(error as Error);
    }
  };

  ws.on('message', (data, isBinary) => {
    if (configApplied) return;
    if (isBinary) {
      handleFatal(new Error('binary payloads are not supported for replay'));
      return;
    }
    void (async () => {
      try {
        const parsed = JSON.parse(data.toString());
        const configMsg = streamingConfigMessageSchema.parse(parsed) as StreamingConfigMessage;
        configApplied = true;
        await attachPlayback(configMsg);
      } catch (err) {
        handleFatal(err as Error);
      }
    })();
  });

  ws.on('close', () => {
    void (async () => {
      for (const transcoder of fileTranscoders.values()) {
        transcoder.stop();
      }
      for (const session of sessions.values()) {
        await session.controller.end().catch(() => undefined);
        await session.controller.close().catch(() => undefined);
      }
      if (latencyStore) {
        await Promise.all(
          Array.from(sessions.entries()).map(([provider, session]) =>
            persistLatency(
              session.latencies,
              { sessionId, provider, lang, startedAt },
              latencyStore
            ).catch(() => undefined)
          )
        );
      }
      await sessionStore.cleanup(sessionId);
      for (const provider of sessions.keys()) {
        recordLog(provider, { type: 'session_end', endedAt: new Date().toISOString() });
      }
    })().catch((error) => {
      logger.error({ event: 'replay_multi_ws_close_error', message: (error as Error).message });
    });
  });

  ws.on('error', (error) => {
    handleFatal(error);
  });
}
