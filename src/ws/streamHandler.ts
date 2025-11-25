import type { WebSocket, RawData } from 'ws';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config.js';
import { getAdapter } from '../adapters/index.js';
import { logger } from '../logger.js';
import { spawnPcmTranscoder } from '../utils/ffmpeg.js';
import { streamingConfigMessageSchema } from '../validation.js';
import type {
  ProviderId,
  StreamingConfigMessage,
  StreamErrorMessage,
  StreamTranscriptMessage,
  StreamSessionMessage,
  RealtimeLatencySummary,
  StorageDriver,
} from '../types.js';

export async function handleStreamConnection(
  ws: WebSocket,
  provider: ProviderId,
  lang: string,
  latencyStore: StorageDriver<RealtimeLatencySummary>
) {
  const config = await loadConfig();
  const adapter = getAdapter(provider);
  let transcoder: ReturnType<typeof spawnPcmTranscoder> | null = null;
  const ensureTranscoder = () => {
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
  const pcmQueue: Buffer[] = [];
  let queuedBytes = 0;
  let sessionStarted = false;
  let controller: Awaited<ReturnType<typeof adapter.startStreaming>>['controller'] | null = null;
  let firstAudioSentAt: number | null = null;
  let lastAudioSentAt: number | null = null;
  const sessionId = randomUUID();
  const latencies: number[] = [];
  const startedAt = new Date().toISOString();
  const maxQueueBytes = config.ws?.maxPcmQueueBytes ?? 5 * 1024 * 1024;
  let closed = false;

  function sendJson(payload: StreamTranscriptMessage | StreamErrorMessage | StreamSessionMessage) {
    ws.send(JSON.stringify(payload));
  }

  const bufferToArrayBuffer = (buffer: Buffer): ArrayBuffer =>
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

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
            if (typeof latencyMs === 'number') {
              latencies.push(latencyMs);
            }
            const payload: StreamTranscriptMessage = {
              type: 'transcript',
              ...transcript,
              channel: transcript.channel ?? 'mic',
              latencyMs,
            };
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

function summarizeLatency(values: number[]) {
  if (values.length === 0) {
    return { count: 0, avg: null, p50: null, p95: null, min: null, max: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = (q: number) => {
    const pos = (sorted.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    if (sorted[base + 1] !== undefined) return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
    return sorted[base];
  };
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return {
    count: values.length,
    avg,
    p50: quantile(0.5),
    p95: quantile(0.95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

export async function persistLatency(
  values: number[],
  meta: { sessionId: string; provider: ProviderId; lang: string; startedAt: string },
  store?: StorageDriver<RealtimeLatencySummary>
) {
  if (!store) return;
  const endedAt = new Date().toISOString();
  const stats = summarizeLatency(values);
  if (stats.count === 0) return;
  await store.append({
    sessionId: meta.sessionId,
    provider: meta.provider,
    lang: meta.lang,
    startedAt: meta.startedAt,
    endedAt,
    ...stats,
  });
}
