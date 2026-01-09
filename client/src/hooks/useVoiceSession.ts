import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import pcmWorkletUrl from '../audio/pcmWorklet.js?url';
import { PcmPlayer, DEFAULT_OUTPUT_SAMPLE_RATE } from '../audio/pcmPlayer';
import { STREAM_HEADER_BYTES } from '../utils/streamHeader';
import type {
  VoiceClientConfigMessage,
  VoiceClientMessage,
  VoiceInputSource,
  VoiceServerMessage,
  VoiceState,
  UrlCitation,
} from '../types/voice';

type ChatItem = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  ts: number;
  turnId?: string;
  source?: VoiceInputSource;
  speakerId?: string;
  triggered?: boolean;
  citations?: UrlCitation[];
};

type VoiceTimings = {
  turnId: string;
  llmMs?: number;
  ttsTtfbMs?: number;
  ts: number;
};

type MeetingWindowState = {
  open: boolean;
  expiresAt?: number;
  reason?: 'wake_word' | 'timeout' | 'manual' | 'cooldown';
  ts?: number;
};

const DEFAULT_CHUNK_MS = 50;
const DEFAULT_WAKE_WORDS = ['アシスタント', 'assistant', 'AI'];
const ASSISTANT_RMS_ALPHA = 0.12;
const ASSISTANT_ECHO_WARMUP_MS = 800;
const ASSISTANT_ECHO_WARMUP_FRAMES = 14;
const ASSISTANT_ECHO_GUARD_FACTOR = 1.8;
const PREROLL_MAX_MS = 1200;
const RMS_UPDATE_INTERVAL_MS = 120;

const buildMicConstraints = (deviceId?: string): MediaTrackConstraints | boolean => {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getSupportedConstraints) {
    return deviceId ? { deviceId: { exact: deviceId } } : true;
  }
  const supported = navigator.mediaDevices.getSupportedConstraints();
  const constraints: MediaTrackConstraints = {};
  if (deviceId) constraints.deviceId = { exact: deviceId };
  if (supported.channelCount) constraints.channelCount = 1;
  // Voice mode prioritizes practical UX (echo cancellation + noise suppression) over fairness benchmarking.
  if (supported.echoCancellation) constraints.echoCancellation = true;
  if (supported.noiseSuppression) constraints.noiseSuppression = true;
  if (supported.autoGainControl) constraints.autoGainControl = true;
  if (supported.sampleSize) constraints.sampleSize = 16;
  return Object.keys(constraints).length > 0 ? constraints : true;
};

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
  monitorOutputDeviceId?: string;
  /** Allow mixing the local mic into Meet output (default: true). */
  allowMicToMeet?: boolean;
  meetingRequireWakeWord?: boolean;
  wakeWords?: readonly string[];
  presetMode?: 'pipeline' | 'openai_realtime';
};

type VoiceStartOptions = {
  presetId?: string;
  micDeviceId?: string;
  meeting?: VoiceMeetingStartOptions;
};

export function useVoiceSession(options: { apiBase: string; lang: string }) {
  const { apiBase, lang } = options;
  const wsBase = useMemo(() => apiBase.replace(/^http/, 'ws').replace(/\/$/, ''), [apiBase]);
  const wsUrl = useMemo(() => `${wsBase}/ws/voice?${new URLSearchParams({ lang }).toString()}`, [lang, wsBase]);

  const [state, setState] = useState<VoiceState>('listening');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [interim, setInterim] = useState<{
    text: string;
    source?: VoiceInputSource;
    speakerId?: string;
    triggered?: boolean;
  } | null>(
    null
  );
  const [lastTimings, setLastTimings] = useState<VoiceTimings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [meetingWindow, setMeetingWindow] = useState<MeetingWindowState | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [outputSampleRate, setOutputSampleRate] = useState(DEFAULT_OUTPUT_SAMPLE_RATE);
  const [micRms, setMicRms] = useState(0);
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
  const micRmsEmaRef = useRef(0);
  const lastRmsUpdateRef = useRef(0);
  const bargeAboveMicRef = useRef(0);
  const bargeAboveMeetingRef = useRef(0);
  const assistantRmsEmaRef = useRef(0);
  const assistantLeakRatioRef = useRef(0);
  const assistantWarmupFramesRef = useRef(0);
  const assistantStartMsRef = useRef(0);
  const monitorAssistantRef = useRef(true);
  const meetOutputEnabledRef = useRef(false);
  const sessionReadyRef = useRef(false);
  const prerollQueueRef = useRef<Array<{ packet: ArrayBuffer; durationMs: number }>>([]);
  const prerollDurationMsRef = useRef(0);

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

  const resetPreroll = useCallback(() => {
    sessionReadyRef.current = false;
    prerollQueueRef.current = [];
    prerollDurationMsRef.current = 0;
    setIsReady(false);
  }, []);

  const flushPreroll = useCallback(() => {
    if (!sessionReadyRef.current) return;
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const queue = prerollQueueRef.current;
    if (queue.length === 0) return;
    queue.forEach(({ packet }) => {
      socket.send(packet);
    });
    queue.length = 0;
    prerollDurationMsRef.current = 0;
  }, []);

  const sendOrBufferPacket = useCallback(
    (packet: ArrayBuffer, durationMs: number) => {
      const socket = wsRef.current;
      if (sessionReadyRef.current && socket && socket.readyState === WebSocket.OPEN) {
        if (prerollQueueRef.current.length > 0) {
          flushPreroll();
        }
        socket.send(packet);
        return;
      }
      const safeDuration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : DEFAULT_CHUNK_MS;
      const queue = prerollQueueRef.current;
      queue.push({ packet, durationMs: safeDuration });
      prerollDurationMsRef.current += safeDuration;
      while (prerollDurationMsRef.current > PREROLL_MAX_MS && queue.length > 0) {
        const removed = queue.shift();
        if (removed) {
          prerollDurationMsRef.current -= removed.durationMs;
        }
      }
    },
    [flushPreroll]
  );

  const updateMicRms = useCallback((rms: number) => {
    const next = micRmsEmaRef.current * 0.8 + rms * 0.2;
    micRmsEmaRef.current = next;
    const now = Date.now();
    if (now - lastRmsUpdateRef.current >= RMS_UPDATE_INTERVAL_MS) {
      lastRmsUpdateRef.current = now;
      setMicRms(next);
    }
  }, []);

  const stopAll = useCallback(async () => {
    setIsRunning(false);
    wsRef.current?.close();
    wsRef.current = null;
    speakingRef.current = false;
    meetOutputEnabledRef.current = false;
    bargeAboveMicRef.current = 0;
    bargeAboveMeetingRef.current = 0;
    assistantRmsEmaRef.current = 0;
    assistantLeakRatioRef.current = 0;
    assistantWarmupFramesRef.current = 0;
    assistantStartMsRef.current = 0;
    resetPreroll();
    micRmsEmaRef.current = 0;
    lastRmsUpdateRef.current = 0;
    setMicRms(0);
    setWarning(null);
    setMeetingWindow(null);
    await stopMedia();
    await playerRef.current.close();
  }, [resetPreroll, stopMedia]);

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
      const baseThreshold = Math.max(0.02, noise * 3.5);
      let effectiveThreshold = baseThreshold;

      if (source === 'mic' && monitorAssistantRef.current) {
        const assistantRms = assistantRmsEmaRef.current;
        if (assistantRms > 0) {
          const now = Date.now();
          if (
            assistantStartMsRef.current > 0
            && now - assistantStartMsRef.current < ASSISTANT_ECHO_WARMUP_MS
            && assistantWarmupFramesRef.current < ASSISTANT_ECHO_WARMUP_FRAMES
            && rms < baseThreshold * 1.5
          ) {
            const ratio = rms / (assistantRms + 1e-4);
            const clamped = Math.max(0, Math.min(1, ratio));
            const prev = assistantLeakRatioRef.current;
            assistantLeakRatioRef.current = prev === 0 ? clamped : prev * 0.8 + clamped * 0.2;
            assistantWarmupFramesRef.current += 1;
          }
          const leakRatio = assistantLeakRatioRef.current;
          if (leakRatio > 0) {
            const echoEstimate = assistantRms * leakRatio;
            effectiveThreshold = Math.max(effectiveThreshold, echoEstimate * ASSISTANT_ECHO_GUARD_FACTOR);
          }
        }
      }
      if (source === 'meeting' && meetOutputEnabledRef.current) {
        const assistantRms = assistantRmsEmaRef.current;
        if (assistantRms > 0) {
          effectiveThreshold = Math.max(effectiveThreshold, assistantRms * ASSISTANT_ECHO_GUARD_FACTOR);
        }
      }

      if (rms > effectiveThreshold) {
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
    setWarning(null);
    setMeetingWindow(null);
    setMessages([]);
    setInterim(null);
    setLastTimings(null);
    setSessionId(null);
    setState('listening');
    setIsRunning(true);
    resetPreroll();
    micRmsEmaRef.current = 0;
    lastRmsUpdateRef.current = 0;
    setMicRms(0);
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
    monitorAssistantRef.current = monitorAssistant;
    const monitorOutputDeviceId = meeting?.monitorOutputDeviceId?.trim();
    const enableMeetOutput = meeting?.enableMeetOutput === true;
    meetOutputEnabledRef.current = enableMeetOutput;
    const meetOutputDeviceId = meeting?.meetOutputDeviceId?.trim();
    const allowMicToMeet = meeting?.allowMicToMeet !== false;
    const meetingRequireWakeWord = meeting?.meetingRequireWakeWord ?? true;
    const wakeWords = (meeting?.wakeWords ?? DEFAULT_WAKE_WORDS).map((w) => w.trim()).filter(Boolean);
    const micDeviceId = opts?.micDeviceId?.trim();

    try {
      // Create/prime the playback AudioContext while we're still in the user gesture.
      const playbackContext = playerRef.current.ensure(outputSampleRateRef.current);
      void playbackContext.resume().catch(() => undefined);
      const monitorResult = await playerRef.current.setMonitorOutput(monitorAssistant, monitorOutputDeviceId || undefined);
      if (monitorResult?.warning) {
        setWarning(monitorResult.warning);
      }

      if (enableMeetOutput && !meetOutputDeviceId) {
        throw new Error('Meet 出力を有効にするには出力デバイスを選択してください（例: BlackHole）');
      }
      await playerRef.current.setMeetOutput(enableMeetOutput, meetOutputDeviceId ?? undefined);

      assistantRmsEmaRef.current = 0;
      assistantLeakRatioRef.current = 0;
      assistantWarmupFramesRef.current = 0;
      assistantStartMsRef.current = 0;

      const requestMicStream = async (deviceId?: string) => {
        try {
          return await navigator.mediaDevices.getUserMedia({ audio: buildMicConstraints(deviceId) });
        } catch (err) {
          if (deviceId) {
            const name = (err as DOMException)?.name;
            if (name === 'OverconstrainedError' || name === 'NotFoundError' || name === 'NotReadableError') {
              console.warn('voice mic selection failed, falling back to default device', err);
              return await navigator.mediaDevices.getUserMedia({ audio: buildMicConstraints() });
            }
          }
          throw err;
        }
      };

      const stream = await requestMicStream(micDeviceId || undefined);
      streamRef.current = stream;
      playerRef.current.setMicStream(stream, { toMeet: enableMeetOutput && allowMicToMeet });
      playerRef.current.setMeetMicMuted(false);

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
        const videoTrack = meetingStream.getVideoTracks()[0];
        const displaySurface = videoTrack?.getSettings().displaySurface;
        if (displaySurface && displaySurface !== 'browser') {
          meetingStream.getTracks().forEach((t) => t.stop());
          throw new Error('Meet タブ共有を選択してください（画面/ウィンドウ共有は誤認しやすいです）');
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
                meetingOutputEnabled: enableMeetOutput,
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
            playerRef.current.ensure(outputSampleRateRef.current);
            playerRef.current.playChime('error');
            setError(payload.message);
            return;
          }
          if (payload.type === 'voice_session') {
            setSessionId(payload.sessionId);
            const sampleRate = payload.outputAudioSpec?.sampleRate ?? DEFAULT_OUTPUT_SAMPLE_RATE;
            outputSampleRateRef.current = sampleRate;
            setOutputSampleRate(sampleRate);
            playerRef.current.ensure(sampleRate);
            sessionReadyRef.current = true;
            setIsReady(true);
            flushPreroll();
            return;
          }
          if (payload.type === 'voice_state') {
            setState(payload.state);
            speakingRef.current = payload.state === 'speaking';
            playerRef.current.setMeetMicMuted(enableMeetOutput && allowMicToMeet && payload.state === 'speaking');
            if (payload.state === 'speaking' && payload.turnId) {
              playerRef.current.beginTurn(payload.turnId);
            }
            if (payload.state !== 'speaking') {
              bargeAboveMicRef.current = 0;
              bargeAboveMeetingRef.current = 0;
            }
            return;
          }
          if (payload.type === 'voice_meeting_window') {
            setMeetingWindow({
              open: payload.state === 'opened',
              expiresAt: payload.expiresAt,
              reason: payload.reason,
              ts: payload.ts,
            });
            if (payload.state === 'opened') {
              playerRef.current.ensure(outputSampleRateRef.current);
              playerRef.current.playChime('listening');
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
                  triggered: payload.triggered,
                },
              ]);
            } else {
              setInterim({
                text: payload.text,
                source: payload.source,
                speakerId: payload.speakerId,
                triggered: payload.triggered,
              });
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
                citations: payload.citations,
              },
            ]);
            return;
          }
          if (payload.type === 'voice_assistant_audio_start') {
            speakingRef.current = true;
            playerRef.current.ensure(outputSampleRateRef.current);
            playerRef.current.beginTurn(payload.turnId);
            assistantRmsEmaRef.current = 0;
            assistantLeakRatioRef.current = 0;
            assistantWarmupFramesRef.current = 0;
            assistantStartMsRef.current = Date.now();
            playerRef.current.playChime('speaking');
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
            assistantRmsEmaRef.current = 0;
            assistantLeakRatioRef.current = 0;
            assistantWarmupFramesRef.current = 0;
            assistantStartMsRef.current = 0;
            if (payload.reason === 'error') {
              playerRef.current.ensure(outputSampleRateRef.current);
              playerRef.current.playChime('error');
            }
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
          const rms = computeRms(arrayBuffer);
          assistantRmsEmaRef.current = assistantRmsEmaRef.current * (1 - ASSISTANT_RMS_ALPHA) + rms * ASSISTANT_RMS_ALPHA;
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
          sendOrBufferPacket(packet, payload.durationMs);
        };

        if (payload.channelSplit && payload.pcmLeft && payload.pcmRight) {
          sendFrame(payload.seq * 2, payload.pcmLeft);
          sendFrame(payload.seq * 2 + 1, payload.pcmRight);

          const rmsMic = computeRms(payload.pcmLeft);
          noiseEmaMicRef.current = noiseEmaMicRef.current * 0.97 + rmsMic * 0.03;
          updateMicRms(rmsMic);
          maybeBargeIn('mic', rmsMic);

          const rmsMeeting = computeRms(payload.pcmRight);
          noiseEmaMeetingRef.current = noiseEmaMeetingRef.current * 0.97 + rmsMeeting * 0.03;
          return;
        }

        if (!payload.pcm) return;
        sendFrame(payload.seq, payload.pcm);

        const rms = computeRms(payload.pcm);
        noiseEmaMicRef.current = noiseEmaMicRef.current * 0.97 + rms * 0.03;
        updateMicRms(rms);
        maybeBargeIn('mic', rms);
      };
    } catch (err) {
      console.error(err);
      setError((err as Error).message ?? '音声会話の開始に失敗しました');
      setIsRunning(false);
      await stopAll();
    }
  }, [
    flushPreroll,
    maybeBargeIn,
    outputSampleRate,
    resetPreroll,
    sendJson,
    sendOrBufferPacket,
    stopAll,
    updateMicRms,
    wsUrl,
  ]);

  return {
    isRunning,
    isReady,
    state,
    sessionId,
    messages,
    interim,
    lastTimings,
    error,
    warning,
    meetingWindow,
    outputSampleRate,
    micRms,
    start,
    stop: stopAll,
    resetHistory,
    stopSpeaking,
  };
}
