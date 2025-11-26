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

const getSupportedMimeType = (): string => {
  if (typeof MediaRecorder === 'undefined') return '';
  const types = ['audio/webm; codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg; codecs=opus', 'audio/wav'];
  return types.find((type) => MediaRecorder.isTypeSupported(type)) || '';
};

export const useStreamSession = ({ chunkMs, apiBase, buildStreamingConfig, buildWsUrl, retry, onSessionClose }: UseStreamSessionConfig) => {
  const [transcripts, setTranscripts] = useState<TranscriptRow[]>([]);
  const [latencies, setLatencies] = useState<number[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamingRef = useRef(false);

  const resetStreamState = useCallback(() => {
    setTranscripts([]);
    setLatencies([]);
    setSessionId(null);
    setError(null);
  }, []);

  useEffect(() => () => {
    recorderRef.current?.stream.getTracks().forEach((track) => track.stop());
    recorderRef.current?.stop();
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
            setTranscripts((prev) => [
              ...prev.slice(-99),
              {
                text: payload.text!,
                provider: payload.provider || '',
                isFinal: !!payload.isFinal,
                timestamp: payload.timestamp!,
                latencyMs: payload.latencyMs,
              },
            ]);
            if (typeof payload.latencyMs === 'number') {
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
    [onSessionClose, retry]
  );

  const startMic = useCallback(
    async (deviceId?: string) => {
      const mimeType = getSupportedMimeType();
      if (!mimeType) {
        setError('このブラウザはサポートされている音声形式が検出できません');
        return;
      }

      resetStreamState();
      retry.reset();
      setIsStreaming(true);
      setError(null);

      try {
        const audioConstraints: MediaTrackConstraints = {};
        if (deviceId) {
          audioConstraints.deviceId = { exact: deviceId };
        }
        const stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? audioConstraints : true });
        const mediaRecorder = new MediaRecorder(stream, {
          mimeType,
          audioBitsPerSecond: 64000,
        });

        const socket = new WebSocket(buildWsUrl('stream'));
        wsRef.current = socket;
        recorderRef.current = mediaRecorder;

        const cleanup = () => {
          if (recorderRef.current && recorderRef.current.state !== 'inactive') {
            recorderRef.current.stop();
          }
          stream.getTracks().forEach((track) => track.stop());
          wsRef.current = null;
        };

        attachRealtimeSocketHandlers(socket, () => startMic(deviceId), cleanup);

        socket.addEventListener('open', () => {
          if (wsRef.current !== socket) return;
          socket.send(JSON.stringify(buildStreamingConfig()));
          if (mediaRecorder.state === 'inactive') {
            mediaRecorder.start(chunkMs);
          }
        });

        mediaRecorder.addEventListener('dataavailable', (event) => {
          if (event.data.size > 0 && wsRef.current === socket && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(event.data);
          }
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
            throw new Error(parsed.message ?? '内部再生セッションの開始に失敗しました');
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
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
      recorderRef.current.stream.getTracks().forEach((track) => track.stop());
    }
    setSessionId(null);
    retry.reset();
  }, [retry]);

  return {
    transcripts,
    latencies,
    isStreaming,
    error,
    sessionId,
    startMic,
    startReplay,
    stop,
    setError,
    resetStreamState,
  };
};
