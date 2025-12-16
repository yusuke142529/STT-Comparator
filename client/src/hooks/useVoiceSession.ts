import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import pcmWorkletUrl from '../audio/pcmWorklet.js?url';
import { STREAM_HEADER_BYTES } from '../utils/streamHeader';
import type { VoiceClientConfigMessage, VoiceClientMessage, VoiceServerMessage, VoiceState } from '../types/voice';

type ChatItem = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  ts: number;
  turnId?: string;
};

type VoiceTimings = {
  turnId: string;
  llmMs?: number;
  ttsTtfbMs?: number;
  ts: number;
};

const DEFAULT_CHUNK_MS = 50;
const DEFAULT_OUTPUT_SAMPLE_RATE = 16000;

const buildMicConstraints = (): MediaTrackConstraints | boolean => {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getSupportedConstraints) {
    return true;
  }
  const supported = navigator.mediaDevices.getSupportedConstraints();
  const constraints: MediaTrackConstraints = {};
  if (supported.channelCount) constraints.channelCount = 1;
  // Voice mode prioritizes practical UX (echo cancellation + noise suppression) over fairness benchmarking.
  if (supported.echoCancellation) constraints.echoCancellation = true;
  if (supported.noiseSuppression) constraints.noiseSuppression = true;
  if (supported.autoGainControl) constraints.autoGainControl = true;
  if (supported.sampleSize) constraints.sampleSize = 16;
  return Object.keys(constraints).length > 0 ? constraints : true;
};

class PcmPlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private nextTime = 0;
  private scheduled: AudioBufferSourceNode[] = [];
  private sampleRate = DEFAULT_OUTPUT_SAMPLE_RATE;

  ensure(sampleRate: number) {
    this.sampleRate = sampleRate;
    if (!this.ctx) {
      const context = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = context;
      this.gain = context.createGain();
      this.gain.gain.value = 1;
      this.gain.connect(context.destination);
      this.nextTime = context.currentTime + 0.05;
    }
    return this.ctx;
  }

  enqueuePcm(buffer: ArrayBuffer) {
    if (!this.ctx || !this.gain) return;
    const ctx = this.ctx;
    const pcm = new Int16Array(buffer);
    if (pcm.length === 0) return;
    const float32 = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i += 1) {
      float32[i] = pcm[i] / 32768;
    }
    const audioBuffer = ctx.createBuffer(1, float32.length, this.sampleRate);
    audioBuffer.copyToChannel(float32, 0);
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.gain);
    const now = ctx.currentTime;
    if (this.nextTime < now + 0.02) {
      this.nextTime = now + 0.02;
    }
    source.start(this.nextTime);
    this.nextTime += audioBuffer.duration;
    this.scheduled.push(source);
    source.onended = () => {
      this.scheduled = this.scheduled.filter((n) => n !== source);
    };
    void ctx.resume().catch(() => undefined);
  }

  clear() {
    this.scheduled.forEach((node) => {
      try {
        node.stop();
      } catch {
        // ignore
      }
    });
    this.scheduled = [];
    if (this.ctx) {
      this.nextTime = this.ctx.currentTime + 0.02;
    }
  }

  async close() {
    this.clear();
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      this.gain = null;
      await ctx.close().catch(() => undefined);
    }
  }
}

function computeRms(pcm: ArrayBuffer): number {
  const samples = new Int16Array(pcm);
  if (samples.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i] / 32768;
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / samples.length);
}

export function useVoiceSession(options: { apiBase: string; lang: string }) {
  const { apiBase, lang } = options;
  const wsBase = useMemo(() => apiBase.replace(/^http/, 'ws').replace(/\/$/, ''), [apiBase]);
  const wsUrl = useMemo(() => `${wsBase}/ws/voice?${new URLSearchParams({ lang }).toString()}`, [lang, wsBase]);

  const [state, setState] = useState<VoiceState>('listening');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [interim, setInterim] = useState<string>('');
  const [lastTimings, setLastTimings] = useState<VoiceTimings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [outputSampleRate, setOutputSampleRate] = useState(DEFAULT_OUTPUT_SAMPLE_RATE);
  const outputSampleRateRef = useRef(DEFAULT_OUTPUT_SAMPLE_RATE);

  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const timeBaseMsRef = useRef(0);
  const playerRef = useRef<PcmPlayer>(new PcmPlayer());
  const speakingRef = useRef(false);
  const bargeCooldownUntilRef = useRef(0);
  const noiseEmaRef = useRef(0.005);
  const bargeAboveRef = useRef(0);

  const stopMedia = useCallback(async () => {
    workletNodeRef.current?.disconnect();
    workletNodeRef.current = null;
    sourceNodeRef.current?.disconnect();
    sourceNodeRef.current = null;
    if (audioContextRef.current) {
      const ctx = audioContextRef.current;
      audioContextRef.current = null;
      await ctx.close().catch(() => undefined);
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const sendJson = useCallback((payload: VoiceClientMessage) => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(payload));
  }, []);

  const stopAll = useCallback(async () => {
    setIsRunning(false);
    wsRef.current?.close();
    wsRef.current = null;
    speakingRef.current = false;
    bargeAboveRef.current = 0;
    await stopMedia();
    await playerRef.current.close();
  }, [stopMedia]);

  useEffect(() => () => {
    void stopAll();
  }, [stopAll]);

  const resetHistory = useCallback(() => {
    setMessages([]);
    setInterim('');
    sendJson({ type: 'command', name: 'reset_history' });
  }, [sendJson]);

  const stopSpeaking = useCallback(() => {
    speakingRef.current = false;
    playerRef.current.clear();
    sendJson({ type: 'command', name: 'stop_speaking' });
  }, [sendJson]);

  const maybeBargeIn = useCallback(
    (rms: number) => {
      if (!speakingRef.current) return;
      const now = Date.now();
      if (now < bargeCooldownUntilRef.current) return;
      const noise = noiseEmaRef.current;
      const threshold = Math.max(0.02, noise * 3.5);
      if (rms > threshold) {
        bargeAboveRef.current += 1;
      } else {
        bargeAboveRef.current = Math.max(0, bargeAboveRef.current - 1);
      }
      if (bargeAboveRef.current >= 2) {
        bargeAboveRef.current = 0;
        bargeCooldownUntilRef.current = now + 1200;
        speakingRef.current = false;
        playerRef.current.clear();
        sendJson({ type: 'command', name: 'barge_in' });
      }
    },
    [sendJson]
  );

  const start = useCallback(async () => {
    setError(null);
    setMessages([]);
    setInterim('');
    setLastTimings(null);
    setSessionId(null);
    setState('listening');
    setIsRunning(true);
    speakingRef.current = false;
    bargeAboveRef.current = 0;

    try {
      // Create/prime the playback AudioContext while we're still in the user gesture.
      const playbackContext = playerRef.current.ensure(outputSampleRateRef.current);
      void playbackContext.resume().catch(() => undefined);

      const stream = await navigator.mediaDevices.getUserMedia({ audio: buildMicConstraints() });
      streamRef.current = stream;

      const micContext = new AudioContext({ latencyHint: 'interactive' });
      audioContextRef.current = micContext;
      await micContext.audioWorklet.addModule(pcmWorkletUrl);
      const source = micContext.createMediaStreamSource(stream);
      sourceNodeRef.current = source;
      const chunkSamples = Math.round((micContext.sampleRate * DEFAULT_CHUNK_MS) / 1000);
      const worklet = new AudioWorkletNode(micContext, 'pcm-worklet', {
        numberOfOutputs: 0,
        processorOptions: { chunkSamples, channelSplit: false },
      });
      workletNodeRef.current = worklet;

      timeBaseMsRef.current = Date.now() - micContext.currentTime * 1000;

      const socket = new WebSocket(wsUrl);
      socket.binaryType = 'arraybuffer';
      wsRef.current = socket;

      socket.addEventListener('open', () => {
        const config: VoiceClientConfigMessage = {
          type: 'config',
          pcm: true,
          clientSampleRate: micContext.sampleRate,
          enableInterim: true,
        };
        socket.send(JSON.stringify(config));
        source.connect(worklet);
        void micContext.resume();
      });

      socket.addEventListener('close', () => {
        if (wsRef.current === socket) {
          wsRef.current = null;
        }
        setIsRunning(false);
        speakingRef.current = false;
        void stopAll();
      });

      socket.addEventListener('message', (event) => {
        const data = event.data;
        if (typeof data === 'string') {
          let payload: VoiceServerMessage | null = null;
          try {
            payload = JSON.parse(data) as VoiceServerMessage;
          } catch {
            return;
          }
          if (payload.type === 'ping') {
            sendJson({ type: 'pong', ts: payload.ts ?? Date.now() });
            return;
          }
          if (payload.type === 'error') {
            setError(payload.message);
            return;
          }
          if (payload.type === 'voice_session') {
            setSessionId(payload.sessionId);
            const sampleRate = payload.outputAudioSpec?.sampleRate ?? DEFAULT_OUTPUT_SAMPLE_RATE;
            outputSampleRateRef.current = sampleRate;
            setOutputSampleRate(sampleRate);
            playerRef.current.ensure(sampleRate);
            return;
          }
          if (payload.type === 'voice_state') {
            setState(payload.state);
            speakingRef.current = payload.state === 'speaking';
            if (payload.state !== 'speaking') {
              bargeAboveRef.current = 0;
            }
            return;
          }
          if (payload.type === 'voice_user_transcript') {
            if (payload.isFinal) {
              setInterim('');
              setMessages((prev) => [
                ...prev,
                { id: `${payload.timestamp}-u`, role: 'user', text: payload.text, ts: payload.timestamp },
              ]);
            } else {
              setInterim(payload.text);
            }
            return;
          }
          if (payload.type === 'voice_assistant_text') {
            setMessages((prev) => [
              ...prev,
              {
                id: `${payload.timestamp}-a`,
                role: 'assistant',
                text: payload.text,
                ts: payload.timestamp,
                turnId: payload.turnId,
              },
            ]);
            return;
          }
          if (payload.type === 'voice_assistant_audio_start') {
            speakingRef.current = true;
            playerRef.current.ensure(outputSampleRateRef.current);
            setLastTimings({
              turnId: payload.turnId,
              llmMs: payload.llmMs,
              ttsTtfbMs: payload.ttsTtfbMs,
              ts: payload.timestamp,
            });
            return;
          }
          if (payload.type === 'voice_assistant_audio_end') {
            speakingRef.current = false;
            bargeAboveRef.current = 0;
            if (payload.reason && payload.reason !== 'completed') {
              playerRef.current.clear();
            }
            return;
          }
          return;
        }

        const handleBinary = (arrayBuffer: ArrayBuffer) => {
          playerRef.current.ensure(outputSampleRateRef.current);
          playerRef.current.enqueuePcm(arrayBuffer);
        };

        if (data instanceof ArrayBuffer) {
          handleBinary(data);
          return;
        }
        if (data instanceof Blob) {
          void data.arrayBuffer().then((buf) => handleBinary(buf));
        }
      });

      worklet.port.onmessage = (event: MessageEvent) => {
        const payload = event.data as { seq: number; pcm?: ArrayBuffer; durationMs: number; endTimeMs: number };
        const socketRef = wsRef.current;
        if (!socketRef || socketRef.readyState !== WebSocket.OPEN) return;
        if (!payload.pcm) return;

        const captureTs = timeBaseMsRef.current + payload.endTimeMs;
        const packet = new ArrayBuffer(STREAM_HEADER_BYTES + payload.pcm.byteLength);
        const view = new DataView(packet);
        view.setUint32(0, payload.seq, true);
        view.setFloat64(4, captureTs, true);
        view.setFloat32(12, payload.durationMs, true);
        new Uint8Array(packet, STREAM_HEADER_BYTES).set(new Uint8Array(payload.pcm));
        socketRef.send(packet);

        const rms = computeRms(payload.pcm);
        noiseEmaRef.current = noiseEmaRef.current * 0.97 + rms * 0.03;
        maybeBargeIn(rms);
      };
    } catch (err) {
      console.error(err);
      setError((err as Error).message ?? '音声会話の開始に失敗しました');
      setIsRunning(false);
      await stopAll();
    }
  }, [maybeBargeIn, outputSampleRate, sendJson, stopAll, wsUrl]);

  return {
    isRunning,
    state,
    sessionId,
    messages,
    interim,
    lastTimings,
    error,
    outputSampleRate,
    start,
    stop: stopAll,
    resetHistory,
    stopSpeaking,
  };
}
