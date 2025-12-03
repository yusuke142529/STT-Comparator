import { spawn } from 'node:child_process';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { loadConfig } from '../config.js';
import { getAdapter } from '../adapters/index.js';
import { logger } from '../logger.js';
import { bufferToArrayBuffer } from '../utils/buffer.js';
import { persistLatency } from '../utils/latency.js';
import { streamingConfigMessageSchema } from '../validation.js';
import WebSocket from 'ws';
import type { WebSocket as WsType } from 'ws';
import type {
  ProviderId,
  RealtimeLatencySummary,
  RealtimeLogPayload,
  RealtimeTranscriptLogEntry,
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
  const session = sessionStore.take(sessionId);
  if (!session) {
    ws.send(JSON.stringify({ type: 'error', message: 'replay session not found or already consumed' }));
    ws.close();
    return;
  }
  if (session.provider !== provider) {
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
  let closed = false;
  let configApplied = false;
  let pcmBytes = 0;

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

  const sendJson = (payload: StreamTranscriptMessage | { type: 'session'; [key: string]: unknown } | { type: 'error'; message: string }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
    recordLog(payload as RealtimeLogPayload);
  };

  const handleFatal = (error: Error) => {
    if (closed) return;
    closed = true;
    sendJson({ type: 'error', message: error.message });
    fileTranscoder?.stop();
    ws.close();
  };

  const attachPlayback = async (configMsg: StreamingConfigMessage) => {
    try {
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
        const baseTs = lastAudioSentAt ?? firstAudioSentAt;
        const latencyMs = typeof baseTs === 'number' ? Date.now() - baseTs : 0;
        if (typeof latencyMs === 'number') latencies.push(latencyMs);
        const payload: StreamTranscriptMessage = {
          ...transcript,
          type: 'transcript',
          channel: 'file',
          latencyMs,
        };
        sendJson(payload);
      });

      streamingSession.onError(handleFatal);
      streamingSession.onClose(() => {
        ws.close();
      });

      fileTranscoder = spawnFileTranscoder(
        session.filePath,
        config.audio.targetSampleRate,
        config.audio.targetChannels
      );

      fileTranscoder.onError(handleFatal);
      fileTranscoder.onClose((code) => {
        void (async () => {
          const minBytes = Math.ceil(config.audio.targetSampleRate * config.audio.targetChannels * 2 * 0.1); // 100ms
          if (code !== 0) {
            handleFatal(new Error(`ffmpeg exited with code ${code ?? 'unknown'}`));
            return;
          }
          if (pcmBytes < minBytes) {
            handleFatal(
              new Error(
                'audio decoding produced almost no PCM samples (unsupported codec or corrupt file?)'
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
        fileTranscoder?.stream.pause();
        try {
          await controller.sendAudio(bufferToArrayBuffer(chunk));
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

  ws.on('close', () => {
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
    })();
  });

  ws.on('error', (error) => {
    handleFatal(error);
  });
}
