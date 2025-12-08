import { useCallback, useEffect, useRef, useState } from 'react';
import { STREAM_HEADER_BYTES } from '../utils/streamHeader';
import type { NormalizedRow, TranscriptRow, WsPayload } from '../types/app';
import type { RetryController } from './retryController';

interface UseStreamSessionConfig {
  chunkMs: number;
  apiBase: string;
  buildStreamingConfig: () => Record<string, unknown>;
  buildWsUrl: (path: 'stream' | 'stream-compare' | 'replay' | 'replay-multi', providers: string[], sessionId?: string) => string;
  retry: RetryController;
  onSessionClose?: () => void;
}

const DEFAULT_SAMPLE_RATE = 16000;
const OPENAI_SAMPLE_RATE = 24000;

const buildAudioConstraints = (deviceId?: string, sampleRate: number = DEFAULT_SAMPLE_RATE): MediaTrackConstraints | boolean => {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getSupportedConstraints) {
    return deviceId ? { deviceId: { exact: deviceId } } : true;
  }
  const supported = navigator.mediaDevices.getSupportedConstraints();
  const constraints: MediaTrackConstraints = {};
  if (deviceId) constraints.deviceId = { exact: deviceId };
  if (supported.channelCount) constraints.channelCount = 1;
  if (supported.sampleRate) constraints.sampleRate = sampleRate;
  if (supported.sampleSize) constraints.sampleSize = 16;
  if (supported.echoCancellation) constraints.echoCancellation = false;
  if (supported.noiseSuppression) constraints.noiseSuppression = false;
  if (supported.autoGainControl) constraints.autoGainControl = false;
  return Object.keys(constraints).length > 0 ? constraints : deviceId ? { deviceId: { exact: deviceId } } : true;
};

export const useStreamSession = ({ chunkMs, apiBase, buildStreamingConfig, buildWsUrl, retry, onSessionClose }: UseStreamSessionConfig) => {
  const [transcripts, setTranscripts] = useState<TranscriptRow[]>([]);
  const [latencies, setLatencies] = useState<number[]>([]);
  const [latenciesByProvider, setLatenciesByProvider] = useState<Record<string, number[]>>({});
  const [normalizedRows, setNormalizedRows] = useState<NormalizedRow[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const transcriptIdRef = useRef(0);
  const interimByChannelRef = useRef<Record<string, string | null>>({});
  const lastFinalByChannelRef = useRef<Record<string, string | null>>({});
  const normalizedWindowRef = useRef<Map<number, Map<string, NormalizedRow>>>(new Map());

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const streamingRef = useRef(false);

  const resetStreamState = useCallback(() => {
    setTranscripts([]);
    setLatencies([]);
    setLatenciesByProvider({});
    setNormalizedRows([]);
    setSessionId(null);
    setError(null);
    setWarning(null);
    interimByChannelRef.current = {};
    lastFinalByChannelRef.current = {};
    normalizedWindowRef.current = new Map();
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

  const pickTargetSampleRate = useCallback((providers: string[]): number => {
    const unique = Array.from(new Set(providers));
    const onlyOpenAI = unique.length === 1 && unique[0] === 'openai';
    return onlyOpenAI ? OPENAI_SAMPLE_RATE : DEFAULT_SAMPLE_RATE;
  }, []);

  const attachRealtimeSocketHandlers = useCallback(
    (socket: WebSocket, restart: () => void, onDisconnect?: () => void) => {
      const handleMessage = (event: MessageEvent<string>) => {
        try {
          const payload = JSON.parse(event.data) as WsPayload;
          if (payload.type === 'session' && payload.sessionId) {
            setSessionId(payload.sessionId);
            retry.reset();
          } else if (payload.type === 'normalized' && typeof (payload.windowId ?? payload.segmentId) === 'number' && payload.provider) {
            setNormalizedRows((prev) => {
              const map = normalizedWindowRef.current;
              const windowId = payload.windowId ?? payload.segmentId ?? 0;
              const windowMap = map.get(windowId) ?? new Map<string, NormalizedRow>();
              const row: NormalizedRow = {
                normalizedId: payload.normalizedId,
                segmentId: payload.segmentId ?? windowId,
                windowId,
                windowStartMs: payload.windowStartMs ?? windowId * chunkMs,
                windowEndMs: payload.windowEndMs ?? windowId * chunkMs + chunkMs,
                provider: payload.provider!,
                textRaw: payload.textRaw ?? payload.text ?? '',
                textNorm: payload.textNorm ?? payload.textRaw ?? payload.text ?? '',
                textDelta: payload.textDelta,
                isFinal: !!payload.isFinal,
                revision: payload.revision ?? 1,
                latencyMs: payload.latencyMs,
                originCaptureTs: payload.originCaptureTs,
                confidence: payload.confidence ?? null,
                punctuationApplied: payload.punctuationApplied ?? null,
                casingApplied: payload.casingApplied ?? null,
                words: payload.words,
              };
              windowMap.set(payload.provider, row);
              map.set(windowId, windowMap);
              if (map.size > 600) {
                const oldest = Math.min(...map.keys());
                map.delete(oldest);
              }
              const ordered = Array.from(map.entries())
                .sort((a, b) => a[0] - b[0])
                .flatMap(([, providers]) =>
                  Array.from(providers.values()).sort((a, b) => a.provider.localeCompare(b.provider))
                );
              return ordered.slice(-500);
            });
          } else if (payload.type === 'transcript' && payload.text && typeof payload.timestamp === 'number') {
            const channel = ((payload as { channel?: string }).channel ?? 'mic') as 'mic' | 'file';
            const isFinal = !!payload.isFinal;
            const provider = payload.provider || '';
            const mergeWindowMs = Math.max(chunkMs * 2, 800);

            setTranscripts((prev) => {
              const next = [...prev];
              const key = `${provider}|${channel}`;
              const currentInterimId = interimByChannelRef.current[key];
              const lastFinalId = lastFinalByChannelRef.current[key];

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
                  interimByChannelRef.current[key] = null;
                  lastFinalByChannelRef.current[key] = currentInterimId;
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
                interimByChannelRef.current[key] = null;
                lastFinalByChannelRef.current[key] = id;
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
              interimByChannelRef.current[key] = id;
              return next.slice(-100);
            });

            if (isFinal && typeof payload.latencyMs === 'number') {
              setLatencies((prev) => [payload.latencyMs!, ...prev].slice(0, 500));
              setLatenciesByProvider((prev) => {
                const current = prev[provider] ?? [];
                return { ...prev, [provider]: [payload.latencyMs!, ...current].slice(0, 500) };
              });
            }
          } else if (payload.type === 'error' && payload.message) {
            setError(payload.message);
            streamingRef.current = false; // avoid auto-retry loops on server-declared fatal errors
            setIsStreaming(false);
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
    async (deviceId?: string, options?: { allowDegraded?: boolean; providers?: string[] }) => {
      const allowDegraded = options?.allowDegraded ?? false;
      const providers = options?.providers ?? [];
      if (providers.length === 0) {
        setError('プロバイダが選択されていません');
        return;
      }
      // Tear down any existing session proactively to avoid leaked AudioContexts/WS.
      wsRef.current?.close();
      stopMedia();

      let degraded = false;
      resetStreamState();
      retry.reset();
      setIsStreaming(true);
      setError(null);
      setWarning(null);

      try {
        const targetSampleRate = pickTargetSampleRate(providers);
        const audioConstraints = buildAudioConstraints(deviceId, targetSampleRate);
        const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
        streamRef.current = stream;

        const settings = stream.getAudioTracks()[0]?.getSettings() ?? {};
        const badSampleRate = typeof settings.sampleRate === 'number' && settings.sampleRate !== targetSampleRate;
        const badChannels = typeof settings.channelCount === 'number' && settings.channelCount !== 1;
        const dspOn =
          settings.echoCancellation === true || settings.noiseSuppression === true || settings.autoGainControl === true;
        if (badSampleRate || badChannels || dspOn) {
          stream.getTracks().forEach((t) => t.stop());
          if (!allowDegraded) {
            setError(
              `マイク設定が仕様と一致しません (${targetSampleRate / 1000}kHz/mono/エフェクトOFF)。ブラウザやOSのマイク設定を確認してください。`
            );
            setIsStreaming(false);
            return;
          }
          degraded = true;
          setWarning(
            `品質低下モードで継続します: ${targetSampleRate / 1000}kHz/mono/エフェクトOFF を満たせませんでした。`
          );
          const retryStream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
          streamRef.current = retryStream;
        }

        const activeStream = streamRef.current ?? stream;
        const requestedSampleRate = targetSampleRate;
        let context = new AudioContext({ sampleRate: requestedSampleRate, latencyHint: 'interactive' });
        audioContextRef.current = context;
        if (context.sampleRate !== targetSampleRate) {
          if (!allowDegraded) {
            activeStream.getTracks().forEach((t) => t.stop());
            await context.close();
            audioContextRef.current = null;
            setError(`AudioContext が ${targetSampleRate / 1000}kHz をサポートしていません (ハードウェア/ブラウザ制限)`);
            setIsStreaming(false);
            return;
          }
          degraded = true;
          setWarning(`品質低下モード: AudioContext が ${targetSampleRate / 1000}kHz ではありません。ブラウザ/デバイスを確認してください。`);
          // Fall back to a hardware-decided rate to keep streaming alive.
          await context.close();
          context = new AudioContext({ latencyHint: 'interactive' });
          audioContextRef.current = context;
        }

        const workletUrl = new URL('../audio/pcmWorklet.js', import.meta.url);
        await context.audioWorklet.addModule(workletUrl);

        const source = context.createMediaStreamSource(activeStream);
        sourceNodeRef.current = source;
        const chunkSamples = Math.round((targetSampleRate * chunkMs) / 1000);
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
          const packet = new ArrayBuffer(STREAM_HEADER_BYTES + payload.pcm.byteLength);
          const view = new DataView(packet);
          view.setUint32(0, payload.seq, true);
          view.setFloat64(4, captureTs, true);
          view.setFloat32(12, payload.durationMs, true);
          new Uint8Array(packet, STREAM_HEADER_BYTES).set(new Uint8Array(payload.pcm));
          socket.send(packet);
        };

        worklet.port.onmessage = (event: MessageEvent) => {
          const data = event.data as { seq: number; pcm: ArrayBuffer; durationMs: number; endTimeMs: number };
          sendPcmChunk(data);
        };

        const path = providers.length > 1 ? 'stream-compare' : 'stream';
        const socket = new WebSocket(buildWsUrl(path, providers));
        wsRef.current = socket;

        const cleanup = () => {
          stopMedia();
          wsRef.current = null;
        };

        attachRealtimeSocketHandlers(socket, () => startMic(deviceId, { allowDegraded, providers }), cleanup);

        socket.addEventListener('open', () => {
          if (wsRef.current !== socket) return;
          socket.send(
            JSON.stringify({
              ...buildStreamingConfig(),
              pcm: true,
              degraded,
              clientSampleRate: context.sampleRate,
            })
          );
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
    async (file: File, options: { providers: string[]; lang: string }) => {
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
        if (options.providers.length > 1) {
          form.append('providers', options.providers.join(','));
        } else {
          form.append('provider', options.providers[0]);
        }
        form.append('lang', options.lang);

        const response = await fetch(`${apiBase}/api/realtime/replay`, { method: 'POST', body: form });
        if (!response.ok) {
          const text = await response.text();
          try {
            const parsed = JSON.parse(text) as { detail?: string; message?: string };
            const detail = parsed?.detail ?? parsed?.message;
            throw new Error(detail ?? '内部再生セッションの開始に失敗しました');
          } catch {
            throw new Error('内部再生セッションの開始に失敗しました');
          }
        }

        const data = (await response.json()) as { sessionId: string };
        const path = options.providers.length > 1 ? 'replay-multi' : 'replay';
        const socket = new WebSocket(buildWsUrl(path, options.providers, data.sessionId));
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
    latenciesByProvider,
    normalizedRows,
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
