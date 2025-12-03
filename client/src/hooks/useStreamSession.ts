import { useCallback, useEffect, useRef, useState } from 'react';
import type { TranscriptRow, WsPayload } from '../types/app';
import type { RetryController } from './retryController';

interface UseStreamSessionConfig {
  chunkMs: number;
  apiBase: string;
  buildStreamingConfig: () => Record<string, unknown>;
  buildWsUrl: (path: 'stream' | 'replay', sessionId?: string) => string;
  retry: RetryController;
  onSessionClose?: () => void;
}

const TARGET_SAMPLE_RATE = 16000;
const HEADER_BYTES = 16; // seq(uint32) + captureTs(float64) + durationMs(float32)

const buildAudioConstraints = (deviceId?: string): MediaTrackConstraints | boolean => {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getSupportedConstraints) {
    return deviceId ? { deviceId: { exact: deviceId } } : true;
  }
  const supported = navigator.mediaDevices.getSupportedConstraints();
  const constraints: MediaTrackConstraints = {};
  if (deviceId) constraints.deviceId = { exact: deviceId };
  if (supported.channelCount) constraints.channelCount = 1;
  if (supported.sampleRate) constraints.sampleRate = 16000;
  if (supported.sampleSize) constraints.sampleSize = 16;
  if (supported.echoCancellation) constraints.echoCancellation = false;
  if (supported.noiseSuppression) constraints.noiseSuppression = false;
  if (supported.autoGainControl) constraints.autoGainControl = false;
  if (supported.latency) constraints.latency = 0.01;
  return Object.keys(constraints).length > 0 ? constraints : deviceId ? { deviceId: { exact: deviceId } } : true;
};

export const useStreamSession = ({ chunkMs, apiBase, buildStreamingConfig, buildWsUrl, retry, onSessionClose }: UseStreamSessionConfig) => {
  const [transcripts, setTranscripts] = useState<TranscriptRow[]>([]);
  const [latencies, setLatencies] = useState<number[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const transcriptIdRef = useRef(0);
  const interimByChannelRef = useRef<Record<string, string | null>>({});
  const lastFinalByChannelRef = useRef<Record<string, string | null>>({});

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const streamingRef = useRef(false);

  const resetStreamState = useCallback(() => {
    setTranscripts([]);
    setLatencies([]);
    setSessionId(null);
    setError(null);
    setWarning(null);
    interimByChannelRef.current = {};
    lastFinalByChannelRef.current = {};
  }, []);

  const stopMedia = useCallback(() => {
    workletNodeRef.current?.disconnect();
    workletNodeRef.current = null;
    sourceNodeRef.current?.disconnect();
    sourceNodeRef.current = null;
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => undefined);
      audioContextRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => () => {
    workletNodeRef.current?.disconnect();
    sourceNodeRef.current?.disconnect();
    audioContextRef.current?.close().catch(() => undefined);
    wsRef.current?.close();
    streamingRef.current = false;
  }, []);

  const attachRealtimeSocketHandlers = useCallback(
    (socket: WebSocket, restart: () => void, onDisconnect?: () => void) => {
      const handleMessage = (event: MessageEvent<string>) => {
        try {
          const payload = JSON.parse(event.data) as WsPayload;
          if (payload.type === 'session' && payload.sessionId) {
            setSessionId(payload.sessionId);
            retry.reset();
          } else if (payload.type === 'transcript' && payload.text && typeof payload.timestamp === 'number') {
            const channel = (payload as { channel?: string }).channel ?? 'mic';
            const isFinal = !!payload.isFinal;
            const provider = payload.provider || '';
            const mergeWindowMs = Math.max(chunkMs * 2, 800);

            setTranscripts((prev) => {
              const next = [...prev];
              const currentInterimId = interimByChannelRef.current[channel];
              const lastFinalId = lastFinalByChannelRef.current[channel];

              const applyUpdate = (targetId: string) => {
                const idx = next.findIndex((row) => row.id === targetId);
                if (idx !== -1) {
                  next[idx] = {
                    ...next[idx],
                    text: payload.text!,
                    provider,
                    channel,
                    isFinal,
                    timestamp: payload.timestamp!,
                    latencyMs: payload.latencyMs,
                    degraded: payload.degraded,
                  };
                  return true;
                }
                return false;
              };

              if (isFinal) {
                if (currentInterimId && applyUpdate(currentInterimId)) {
                  interimByChannelRef.current[channel] = null;
                  lastFinalByChannelRef.current[channel] = currentInterimId;
                  return next;
                }

                if (lastFinalId) {
                  const idx = next.findIndex((row) => row.id === lastFinalId);
                  if (idx !== -1) {
                    const row = next[idx];
                    const withinWindow = payload.timestamp! - row.timestamp <= mergeWindowMs;
                    const sameProvider = row.provider === provider;
                    if (withinWindow && sameProvider) {
                      const separator = row.text.trim().length === 0 || row.text.endsWith(' ') ? '' : ' ';
                      next[idx] = {
                        ...row,
                        text: `${row.text}${separator}${payload.text!}`,
                  timestamp: payload.timestamp!,
                  latencyMs: payload.latencyMs ?? row.latencyMs,
                  degraded: payload.degraded ?? row.degraded,
                };
                return next.slice(-100);
              }
            }
                }

                transcriptIdRef.current += 1;
                const id = `${payload.timestamp}-F-${transcriptIdRef.current}`;
                next.push({
                  id,
                  text: payload.text!,
                  provider,
                  channel,
                  isFinal: true,
                  timestamp: payload.timestamp!,
                  latencyMs: payload.latencyMs,
                  degraded: payload.degraded,
                });
                interimByChannelRef.current[channel] = null;
                lastFinalByChannelRef.current[channel] = id;
                return next.slice(-100);
              }

              // Interim transcript: replace existing for the channel or append new
              if (currentInterimId && applyUpdate(currentInterimId)) {
                return next;
              }

              transcriptIdRef.current += 1;
              const id = `${payload.timestamp}-I-${transcriptIdRef.current}`;
              next.push({
                id,
                text: payload.text!,
                provider,
                channel,
                isFinal: false,
                timestamp: payload.timestamp!,
                latencyMs: payload.latencyMs,
                degraded: payload.degraded,
              });
              interimByChannelRef.current[channel] = id;
              return next.slice(-100);
            });

            if (isFinal && typeof payload.latencyMs === 'number') {
              setLatencies((prev) => [payload.latencyMs!, ...prev].slice(0, 500));
            }
          } else if (payload.type === 'error' && payload.message) {
            setError(payload.message);
            socket.close();
          }
        } catch (err) {
          console.error('Realtime payload parsing failed', err);
        }
      };

      const handleError = () => {
        setError('ストリーム接続でエラーが発生しました');
        stopMedia();
        streamingRef.current = false;
        setIsStreaming(false);
        retry.schedule(restart);
      };

      const handleClose = () => {
        onDisconnect?.();
        if (streamingRef.current) {
          setError('ストリームが切断されました');
          retry.schedule(restart);
        }
        stopMedia();
        streamingRef.current = false;
        setIsStreaming(false);
        setSessionId(null);
        onSessionClose?.();
      };

      socket.addEventListener('message', handleMessage);
      socket.addEventListener('error', handleError);
      socket.addEventListener('close', handleClose);

      return () => {
        socket.removeEventListener('message', handleMessage);
        socket.removeEventListener('error', handleError);
        socket.removeEventListener('close', handleClose);
      };
    },
    [chunkMs, onSessionClose, retry]
  );

  const startMic = useCallback(
    async (deviceId?: string, options?: { allowDegraded?: boolean }) => {
      const allowDegraded = options?.allowDegraded ?? false;
      let degraded = false;
      resetStreamState();
      retry.reset();
      setIsStreaming(true);
      setError(null);
      setWarning(null);

      try {
        const audioConstraints = buildAudioConstraints(deviceId);
        const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
        streamRef.current = stream;

        const settings = stream.getAudioTracks()[0]?.getSettings() ?? {};
        const badSampleRate = typeof settings.sampleRate === 'number' && settings.sampleRate !== TARGET_SAMPLE_RATE;
        const badChannels = typeof settings.channelCount === 'number' && settings.channelCount !== 1;
        const dspOn =
          settings.echoCancellation === true || settings.noiseSuppression === true || settings.autoGainControl === true;
        if (badSampleRate || badChannels || dspOn) {
          stream.getTracks().forEach((t) => t.stop());
          if (!allowDegraded) {
            setError(
              'マイク設定が仕様と一致しません (16kHz/mono/エフェクトOFF)。ブラウザやOSのマイク設定を確認してください。'
            );
            setIsStreaming(false);
            return;
          }
          degraded = true;
          setWarning('品質低下モードで継続します: 16kHz/mono/エフェクトOFF を満たせませんでした。');
          const retryStream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
          streamRef.current = retryStream;
        }

        const activeStream = streamRef.current ?? stream;
        const ctxSampleRate = TARGET_SAMPLE_RATE;
        const context = new AudioContext({ sampleRate: ctxSampleRate, latencyHint: 'interactive' });
        audioContextRef.current = context;
        if (context.sampleRate !== TARGET_SAMPLE_RATE) {
          activeStream.getTracks().forEach((t) => t.stop());
          await context.close();
          audioContextRef.current = null;
          if (!allowDegraded) {
            setError('AudioContext が 16kHz をサポートしていません (ハードウェア/ブラウザ制限)');
            setIsStreaming(false);
            return;
          }
          degraded = true;
          setWarning('品質低下モード: AudioContext が 16kHz ではありません。ブラウザ/デバイスを確認してください。');
        }

        const workletUrl = new URL('../audio/pcmWorklet.js', import.meta.url);
        await context.audioWorklet.addModule(workletUrl);

        const source = context.createMediaStreamSource(activeStream);
        sourceNodeRef.current = source;
        const chunkSamples = Math.round((TARGET_SAMPLE_RATE * chunkMs) / 1000);
        const worklet = new AudioWorkletNode(context, 'pcm-worklet', {
          numberOfOutputs: 0,
          processorOptions: {
            chunkSamples,
          },
        });
        workletNodeRef.current = worklet;

        const timeBaseMs = Date.now() - context.currentTime * 1000;

        const sendPcmChunk = (payload: { seq: number; pcm: ArrayBuffer; durationMs: number; endTimeMs: number }) => {
          const socket = wsRef.current;
          if (!socket || socket.readyState !== WebSocket.OPEN) return;
          const captureTs = timeBaseMs + payload.endTimeMs;
          const packet = new ArrayBuffer(HEADER_BYTES + payload.pcm.byteLength);
          const view = new DataView(packet);
          view.setUint32(0, payload.seq, true);
          view.setFloat64(4, captureTs, true);
          view.setFloat32(12, payload.durationMs, true);
          new Uint8Array(packet, HEADER_BYTES).set(new Uint8Array(payload.pcm));
          socket.send(packet);
        };

        worklet.port.onmessage = (event: MessageEvent) => {
          const data = event.data as { seq: number; pcm: ArrayBuffer; durationMs: number; endTimeMs: number };
          sendPcmChunk(data);
        };

        const socket = new WebSocket(buildWsUrl('stream'));
        wsRef.current = socket;

        const cleanup = () => {
          stopMedia();
          wsRef.current = null;
        };

        attachRealtimeSocketHandlers(socket, () => startMic(deviceId, { allowDegraded }), cleanup);

        socket.addEventListener('open', () => {
          if (wsRef.current !== socket) return;
          socket.send(JSON.stringify({ ...buildStreamingConfig(), pcm: true, degraded }));
          source.connect(worklet);
          // keep graph silent: no destination connection
          void context.resume();
        });

        streamingRef.current = true;
      } catch (err) {
        console.error(err);
        if (err instanceof DOMException && err.name === 'NotAllowedError') {
          setError('マイク許可が拒否されました。許可を与えてから再度お試しください。');
          retry.reset();
          return;
        }
        setError('マイクにアクセスできませんでした');
        setIsStreaming(false);
      }
    },
    [attachRealtimeSocketHandlers, buildStreamingConfig, buildWsUrl, chunkMs, resetStreamState, retry]
  );

  const startReplay = useCallback(
    async (file: File, options: { provider: string; lang: string }) => {
      if (!file) {
        setError('再生する音声ファイルが指定されていません');
        return;
      }

      resetStreamState();
      retry.reset();
      setIsStreaming(true);
      setError(null);

      try {
        const form = new FormData();
        form.append('file', file, file.name);
        form.append('provider', options.provider);
        form.append('lang', options.lang);

        const response = await fetch(`${apiBase}/api/realtime/replay`, { method: 'POST', body: form });
        if (!response.ok) {
          const text = await response.text();
          try {
            const parsed = JSON.parse(text);
            const detail = (parsed as any)?.detail ?? (parsed as any)?.message;
            throw new Error(detail ?? '内部再生セッションの開始に失敗しました');
          } catch {
            throw new Error('内部再生セッションの開始に失敗しました');
          }
        }

        const data = (await response.json()) as { sessionId: string };
        const socket = new WebSocket(buildWsUrl('replay', data.sessionId));
        wsRef.current = socket;

        const cleanup = () => {
          wsRef.current = null;
        };

        attachRealtimeSocketHandlers(socket, () => startReplay(file, options), cleanup);

        socket.addEventListener('open', () => {
          if (wsRef.current !== socket) return;
          socket.send(JSON.stringify(buildStreamingConfig()));
        });

        streamingRef.current = true;
      } catch (err) {
        console.error(err);
        setError((err as Error).message || '内部再生セッションの開始に失敗しました');
        setIsStreaming(false);
        streamingRef.current = false;
      }
    },
    [apiBase, attachRealtimeSocketHandlers, buildStreamingConfig, buildWsUrl, resetStreamState, retry]
  );

  const stop = useCallback(() => {
    streamingRef.current = false;
    setIsStreaming(false);
    wsRef.current?.close();
    stopMedia();
    setSessionId(null);
    retry.reset();
  }, [retry, stopMedia]);

  return {
    transcripts,
    latencies,
    isStreaming,
    error,
    warning,
    sessionId,
    startMic,
    startReplay,
    stop,
    setError,
    setWarning,
    resetStreamState,
  };
};
