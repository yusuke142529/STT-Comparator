import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import pcmWorkletUrl from '../audio/pcmWorklet.js?url';
import { STREAM_HEADER_BYTES } from '../utils/streamHeader';
import type {
  VoiceClientConfigMessage,
  VoiceClientMessage,
  VoiceInputSource,
  VoiceServerMessage,
  VoiceState,
} from '../types/voice';

type ChatItem = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  ts: number;
  turnId?: string;
  source?: VoiceInputSource;
  speakerId?: string;
};

type VoiceTimings = {
  turnId: string;
  llmMs?: number;
  ttsTtfbMs?: number;
  ts: number;
};

const DEFAULT_CHUNK_MS = 50;
const DEFAULT_OUTPUT_SAMPLE_RATE = 16000;
const DEFAULT_WAKE_WORDS = ['アシスタント', 'assistant', 'AI'];

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
  private monitorGain: GainNode | null = null;
  private meetGain: GainNode | null = null;
  private micMeetGain: GainNode | null = null;
  private nextTime = 0;
  private scheduled: AudioBufferSourceNode[] = [];
  private sampleRate = DEFAULT_OUTPUT_SAMPLE_RATE;
  private firstScheduledTime: number | null = null;
  private scheduledDurationSec = 0;
  private meetDestination: MediaStreamAudioDestinationNode | null = null;
  private meetElement: HTMLAudioElement | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private monitorEnabled = true;
  private meetEnabled = false;

  ensure(sampleRate: number) {
    this.sampleRate = sampleRate;
    if (!this.ctx) {
      const context = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = context;
      this.monitorGain = context.createGain();
      this.monitorGain.gain.value = 1;
      this.monitorGain.connect(context.destination);

      this.meetGain = context.createGain();
      this.meetGain.gain.value = 0;
      this.meetDestination = context.createMediaStreamDestination();
      this.meetGain.connect(this.meetDestination);

      this.micMeetGain = context.createGain();
      this.micMeetGain.gain.value = 1;
      this.micMeetGain.connect(this.meetGain);

      if (typeof document !== 'undefined') {
        const el = document.createElement('audio');
        el.autoplay = true;
        el.playsInline = true;
        el.muted = false;
        el.style.display = 'none';
        el.srcObject = this.meetDestination.stream;
        document.body.appendChild(el);
        this.meetElement = el;
      }
      this.nextTime = context.currentTime + 0.05;
    }
    return this.ctx;
  }

  getPlayedMs() {
    if (!this.ctx || this.firstScheduledTime === null) return 0;
    const playedSec = this.ctx.currentTime - this.firstScheduledTime;
    const clamped = Math.max(0, Math.min(this.scheduledDurationSec, playedSec));
    return Math.round(clamped * 1000);
  }

  setMonitorEnabled(enabled: boolean) {
    this.monitorEnabled = enabled;
    if (this.monitorGain) {
      this.monitorGain.gain.value = enabled ? 1 : 0;
    }
  }

  async setMeetOutput(enabled: boolean, deviceId?: string) {
    this.meetEnabled = enabled;
    if (this.meetGain) {
      this.meetGain.gain.value = enabled ? 1 : 0;
    }
    const el = this.meetElement;
    if (!el) return;

    if (enabled && deviceId) {
      const media = el as HTMLMediaElement & { setSinkId?: (sinkId: string) => Promise<void> };
      if (typeof media.setSinkId !== 'function') {
        throw new Error('このブラウザは setSinkId に未対応です（Meet への音声出力には Chrome/Edge 推奨）');
      }
      await media.setSinkId(deviceId);
    }

    if (enabled) {
      await el.play().catch(() => undefined);
    } else {
      el.pause();
    }
  }

  setMicStream(stream: MediaStream | null, opts?: { toMeet?: boolean }) {
    if (!this.ctx) return;
    if (this.micSource) {
      try {
        this.micSource.disconnect();
      } catch {
        // ignore
      }
      this.micSource = null;
    }
    if (!stream) return;
    const source = this.ctx.createMediaStreamSource(stream);
    this.micSource = source;
    if (opts?.toMeet && this.micMeetGain) {
      source.connect(this.micMeetGain);
    }
  }

  enqueuePcm(buffer: ArrayBuffer) {
    if (!this.ctx || !this.monitorGain || !this.meetGain) return;
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
    if (this.monitorEnabled) {
      source.connect(this.monitorGain);
    }
    if (this.meetEnabled) {
      source.connect(this.meetGain);
    }
    const now = ctx.currentTime;
    if (this.nextTime < now + 0.02) {
      this.nextTime = now + 0.02;
    }
    if (this.firstScheduledTime === null) {
      this.firstScheduledTime = this.nextTime;
    }
    source.start(this.nextTime);
    this.nextTime += audioBuffer.duration;
    this.scheduledDurationSec += audioBuffer.duration;
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
    this.firstScheduledTime = null;
    this.scheduledDurationSec = 0;
    if (this.ctx) {
      this.nextTime = this.ctx.currentTime + 0.02;
    }
  }

  async close() {
    this.clear();
    if (this.micSource) {
      try {
        this.micSource.disconnect();
      } catch {
        // ignore
      }
      this.micSource = null;
    }
    if (this.meetElement) {
      const el = this.meetElement;
      this.meetElement = null;
      try {
        el.pause();
      } catch {
        // ignore
      }
      try {
        el.srcObject = null;
      } catch {
        // ignore
      }
      try {
        el.remove();
      } catch {
        // ignore
      }
    }
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      this.monitorGain = null;
      this.meetGain = null;
      this.micMeetGain = null;
      this.meetDestination = null;
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

type VoiceMeetingStartOptions = {
  captureTabAudio?: boolean;
  enableMeetOutput?: boolean;
  meetOutputDeviceId?: string;
  /** Plays assistant audio locally (default: true). */
  monitorAssistant?: boolean;
  meetingRequireWakeWord?: boolean;
  wakeWords?: readonly string[];
  presetMode?: 'pipeline' | 'openai_realtime';
};

type VoiceStartOptions = {
  presetId?: string;
  meeting?: VoiceMeetingStartOptions;
};

export function useVoiceSession(options: { apiBase: string; lang: string }) {
  const { apiBase, lang } = options;
  const wsBase = useMemo(() => apiBase.replace(/^http/, 'ws').replace(/\/$/, ''), [apiBase]);
  const wsUrl = useMemo(() => `${wsBase}/ws/voice?${new URLSearchParams({ lang }).toString()}`, [lang, wsBase]);

  const [state, setState] = useState<VoiceState>('listening');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [interim, setInterim] = useState<{ text: string; source?: VoiceInputSource; speakerId?: string } | null>(
    null
  );
  const [lastTimings, setLastTimings] = useState<VoiceTimings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [outputSampleRate, setOutputSampleRate] = useState(DEFAULT_OUTPUT_SAMPLE_RATE);
  const outputSampleRateRef = useRef(DEFAULT_OUTPUT_SAMPLE_RATE);

  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const meetingStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const timeBaseMsRef = useRef(0);
  const playerRef = useRef<PcmPlayer>(new PcmPlayer());
  const speakingRef = useRef(false);
  const bargeCooldownUntilRef = useRef(0);
  const noiseEmaMicRef = useRef(0.005);
  const noiseEmaMeetingRef = useRef(0.005);
  const bargeAboveMicRef = useRef(0);
  const bargeAboveMeetingRef = useRef(0);

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
    meetingStreamRef.current?.getTracks().forEach((track) => track.stop());
    meetingStreamRef.current = null;
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
    bargeAboveMicRef.current = 0;
    bargeAboveMeetingRef.current = 0;
    await stopMedia();
    await playerRef.current.close();
  }, [stopMedia]);

  useEffect(() => () => {
    void stopAll();
  }, [stopAll]);

  const resetHistory = useCallback(() => {
    setMessages([]);
    setInterim(null);
    const playedMs = playerRef.current.getPlayedMs();
    sendJson({ type: 'command', name: 'reset_history', playedMs });
  }, [sendJson]);

  const stopSpeaking = useCallback(() => {
    const playedMs = playerRef.current.getPlayedMs();
    speakingRef.current = false;
    playerRef.current.clear();
    sendJson({ type: 'command', name: 'stop_speaking', playedMs });
  }, [sendJson]);

  const maybeBargeIn = useCallback(
    (source: VoiceInputSource, rms: number) => {
      if (!speakingRef.current) return;
      const now = Date.now();
      if (now < bargeCooldownUntilRef.current) return;
      const noiseRef = source === 'meeting' ? noiseEmaMeetingRef : noiseEmaMicRef;
      const aboveRef = source === 'meeting' ? bargeAboveMeetingRef : bargeAboveMicRef;
      const noise = noiseRef.current;
      const threshold = Math.max(0.02, noise * 3.5);
      if (rms > threshold) {
        aboveRef.current += 1;
      } else {
        aboveRef.current = Math.max(0, aboveRef.current - 1);
      }
      if (aboveRef.current >= 2) {
        aboveRef.current = 0;
        bargeAboveMicRef.current = 0;
        bargeAboveMeetingRef.current = 0;
        bargeCooldownUntilRef.current = now + 1200;
        const playedMs = playerRef.current.getPlayedMs();
        speakingRef.current = false;
        playerRef.current.clear();
        sendJson({ type: 'command', name: 'barge_in', playedMs });
      }
    },
    [sendJson]
  );

  const start = useCallback(async (opts?: VoiceStartOptions) => {
    setError(null);
    setMessages([]);
    setInterim(null);
    setLastTimings(null);
    setSessionId(null);
    setState('listening');
    setIsRunning(true);
    speakingRef.current = false;
    bargeAboveMicRef.current = 0;
    bargeAboveMeetingRef.current = 0;
    noiseEmaMicRef.current = 0.005;
    noiseEmaMeetingRef.current = 0.005;

    const meeting = opts?.meeting;
    const presetMode = meeting?.presetMode ?? 'pipeline';
    const captureTabAudio = meeting?.captureTabAudio === true;
    const enableChannelSplit = presetMode === 'pipeline' && captureTabAudio;
    const monitorAssistant = meeting?.monitorAssistant !== false;
    const enableMeetOutput = meeting?.enableMeetOutput === true;
    const meetOutputDeviceId = meeting?.meetOutputDeviceId?.trim();
    const meetingRequireWakeWord = meeting?.meetingRequireWakeWord ?? true;
    const wakeWords = (meeting?.wakeWords ?? DEFAULT_WAKE_WORDS).map((w) => w.trim()).filter(Boolean);

    try {
      // Create/prime the playback AudioContext while we're still in the user gesture.
      const playbackContext = playerRef.current.ensure(outputSampleRateRef.current);
      void playbackContext.resume().catch(() => undefined);
      playerRef.current.setMonitorEnabled(monitorAssistant);

      if (enableMeetOutput && !meetOutputDeviceId) {
        throw new Error('Meet 出力を有効にするには出力デバイスを選択してください（例: BlackHole）');
      }
      await playerRef.current.setMeetOutput(enableMeetOutput, meetOutputDeviceId ?? undefined);

      const stream = await navigator.mediaDevices.getUserMedia({ audio: buildMicConstraints() });
      streamRef.current = stream;
      playerRef.current.setMicStream(stream, { toMeet: enableMeetOutput });

      if (captureTabAudio && presetMode !== 'pipeline') {
        throw new Error('Meet タブ音声の取り込みは pipeline プリセットで利用してください');
      }

      if (captureTabAudio) {
        const meetingStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
        const hasAudio = meetingStream.getAudioTracks().length > 0;
        if (!hasAudio) {
          meetingStream.getTracks().forEach((t) => t.stop());
          throw new Error('Meet タブ音声が取得できませんでした（タブ共有の「音声を共有」をONにしてください）');
        }
        meetingStreamRef.current = meetingStream;
        meetingStream.getTracks().forEach((track) => {
          track.addEventListener(
            'ended',
            () => {
              setError('Meet タブ共有が停止されました');
              void stopAll();
            },
            { once: true }
          );
        });
      }

      const micContext = new AudioContext({ latencyHint: 'interactive' });
      audioContextRef.current = micContext;
      await micContext.audioWorklet.addModule(pcmWorkletUrl);
      const source = micContext.createMediaStreamSource(stream);
      sourceNodeRef.current = source;
      const chunkSamples = Math.round((micContext.sampleRate * DEFAULT_CHUNK_MS) / 1000);
      const worklet = new AudioWorkletNode(micContext, 'pcm-worklet', {
        numberOfOutputs: 0,
        processorOptions: { chunkSamples, channelSplit: enableChannelSplit },
      });
      workletNodeRef.current = worklet;

      let captureRoot: AudioNode = source;
      if (enableChannelSplit) {
        const meetingStream = meetingStreamRef.current;
        if (!meetingStream) {
          throw new Error('Meet タブ音声ストリームが見つかりません');
        }
        const meetingSource = micContext.createMediaStreamSource(meetingStream);
        const merger = micContext.createChannelMerger(2);

        const micMono = micContext.createGain();
        micMono.channelCount = 1;
        micMono.channelCountMode = 'explicit';
        micMono.channelInterpretation = 'speakers';
        source.connect(micMono);
        micMono.connect(merger, 0, 0);

        const meetingMono = micContext.createGain();
        meetingMono.channelCount = 1;
        meetingMono.channelCountMode = 'explicit';
        meetingMono.channelInterpretation = 'speakers';
        meetingSource.connect(meetingMono);
        meetingMono.connect(merger, 0, 1);

        captureRoot = merger;
      }

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
          presetId: opts?.presetId,
          channels: enableChannelSplit ? 2 : 1,
          channelSplit: enableChannelSplit,
          options: captureTabAudio
            ? {
                meetingMode: true,
                meetingRequireWakeWord,
                wakeWords: wakeWords.length > 0 ? wakeWords : DEFAULT_WAKE_WORDS,
              }
            : undefined,
        };
        socket.send(JSON.stringify(config));
        captureRoot.connect(worklet);
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
              bargeAboveMicRef.current = 0;
              bargeAboveMeetingRef.current = 0;
            }
            return;
          }
          if (payload.type === 'voice_user_transcript') {
            if (payload.isFinal) {
              setInterim(null);
              setMessages((prev) => [
                ...prev,
                {
                  id: `${payload.timestamp}-u`,
                  role: 'user',
                  text: payload.text,
                  ts: payload.timestamp,
                  source: payload.source,
                  speakerId: payload.speakerId,
                },
              ]);
            } else {
              setInterim({ text: payload.text, source: payload.source, speakerId: payload.speakerId });
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
            bargeAboveMicRef.current = 0;
            bargeAboveMeetingRef.current = 0;
            if (payload.reason && payload.reason !== 'completed') {
              playerRef.current.clear();
            }
            return;
          }
          return;
        }

        const handleBinary = (arrayBuffer: ArrayBuffer) => {
          if (!speakingRef.current) return;
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
        const payload = event.data as {
          seq: number;
          pcm?: ArrayBuffer;
          pcmLeft?: ArrayBuffer;
          pcmRight?: ArrayBuffer;
          durationMs: number;
          endTimeMs: number;
          channelSplit?: boolean;
        };
        const socketRef = wsRef.current;
        if (!socketRef || socketRef.readyState !== WebSocket.OPEN) return;

        const captureTs = timeBaseMsRef.current + payload.endTimeMs;
        const sendFrame = (seq: number, pcm: ArrayBuffer) => {
          const packet = new ArrayBuffer(STREAM_HEADER_BYTES + pcm.byteLength);
          const view = new DataView(packet);
          view.setUint32(0, seq, true);
          view.setFloat64(4, captureTs, true);
          view.setFloat32(12, payload.durationMs, true);
          new Uint8Array(packet, STREAM_HEADER_BYTES).set(new Uint8Array(pcm));
          socketRef.send(packet);
        };

        if (payload.channelSplit && payload.pcmLeft && payload.pcmRight) {
          sendFrame(payload.seq * 2, payload.pcmLeft);
          sendFrame(payload.seq * 2 + 1, payload.pcmRight);

          const rmsMic = computeRms(payload.pcmLeft);
          noiseEmaMicRef.current = noiseEmaMicRef.current * 0.97 + rmsMic * 0.03;
          maybeBargeIn('mic', rmsMic);

          const rmsMeeting = computeRms(payload.pcmRight);
          noiseEmaMeetingRef.current = noiseEmaMeetingRef.current * 0.97 + rmsMeeting * 0.03;
          maybeBargeIn('meeting', rmsMeeting);
          return;
        }

        if (!payload.pcm) return;
        sendFrame(payload.seq, payload.pcm);

        const rms = computeRms(payload.pcm);
        noiseEmaMicRef.current = noiseEmaMicRef.current * 0.97 + rms * 0.03;
        maybeBargeIn('mic', rms);
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
