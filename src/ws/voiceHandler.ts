import type { RawData, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config.js';
import { getAdapter } from '../adapters/index.js';
import { logger } from '../logger.js';
import { bufferToArrayBuffer } from '../utils/buffer.js';
import { parseStreamFrame } from '../utils/streamHeader.js';
import { createPcmResampler } from '../utils/ffmpeg.js';
import { getProviderSampleRate } from '../utils/providerAudio.js';
import { voiceCommandMessageSchema, voiceConfigMessageSchema } from '../validation.js';
import type {
  ProviderId,
  StreamingController,
  VoiceAssistantAudioEndMessage,
  VoiceAssistantAudioStartMessage,
  VoiceAssistantTextMessage,
  VoiceCommandMessage,
  VoiceConfigMessage,
  VoiceInputSource,
  VoiceServerMessage,
  VoiceSessionMessage,
  VoiceState,
  VoiceStateMessage,
  VoiceUserTranscriptMessage,
} from '../types.js';
import { generateChatReply } from '../voice/openaiChat.js';
import { streamTtsPcm } from '../voice/elevenlabsTts.js';
import { streamOpenAiTtsPcm } from '../voice/openaiTts.js';
import { resolveVoicePreset } from '../voice/voicePresets.js';
import type { OpenAiRealtimeVoiceSession } from '../voice/openaiRealtimeVoice.js';
import { startOpenAiRealtimeVoiceSession } from '../voice/openaiRealtimeVoice.js';

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

function getSystemPrompt(): string {
  return (
    process.env.VOICE_SYSTEM_PROMPT ??
    'あなたは日本語で会話する音声アシスタントです。簡潔で自然な日本語で答えてください。'
  );
}

function getHistoryMaxTurns(): number {
  const raw = Number(process.env.VOICE_HISTORY_MAX_TURNS);
  if (Number.isFinite(raw) && raw >= 1) return Math.min(50, Math.round(raw));
  return 12;
}

function stripWakeWord(text: string, wakeWords: readonly string[]) {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const lower = trimmed.toLowerCase();
  for (const w of wakeWords) {
    const token = w.trim();
    if (!token) continue;
    const idx = lower.indexOf(token.toLowerCase());
    if (idx !== 0) continue;
    const rest = trimmed.slice(token.length).replace(/^[\s,、:：-]+/, '').trim();
    return rest || trimmed;
  }
  return trimmed;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function defaultWakeWords(lang: string): string[] {
  const lower = lang.toLowerCase();
  if (lower.startsWith('ja')) {
    return ['アシスタント', 'assistant', 'AI'];
  }
  return ['assistant', 'ai'];
}

export async function handleVoiceConnection(ws: WebSocket, lang: string) {
  const config = await loadConfig();
  const sessionId = randomUUID();
  const startedAt = new Date().toISOString();
  const keepaliveMs = config.ws?.keepaliveMs ?? 30_000;
  const maxMissedPongs = config.ws?.maxMissedPongs ?? 2;
  let outputSampleRate = config.audio.targetSampleRate ?? 16_000;
  const openAiRealtimeSampleRate = 24_000;
  let presetId: string | null = null;
  let presetMode: 'pipeline' | 'openai_realtime' = 'pipeline';
  let sttProvider: ProviderId | null = null;
  let ttsProvider: ProviderId | null = null;
  const llmProvider = 'openai' as const;

  let closed = false;
  let keepaliveTimer: NodeJS.Timeout | null = null;
  let missedPongs = 0;
  let sessionStarted = false;
  let voiceState: VoiceState = 'listening';
  let finalizeDelayMs = 350;

  const systemPrompt = getSystemPrompt();
  const historyMaxTurns = getHistoryMaxTurns();
  const history: ChatMessage[] = [{ role: 'system', content: systemPrompt }];
  const trimHistory = () => {
    while (history.length > 1 + historyMaxTurns * 2) {
      history.splice(1, 2);
    }
  };
  const pendingFinalParts: string[] = [];
  let finalizeTimer: NodeJS.Timeout | null = null;

  // Transcripts captured while assistant is speaking (applied only when barge-in happens).
  let suppressedInterim: { source: VoiceInputSource; text: string } | null = null;
  const suppressedFinalParts: Array<{ source: VoiceInputSource; text: string }> = [];
  const clearSuppressedTranscripts = () => {
    suppressedInterim = null;
    suppressedFinalParts.length = 0;
  };

  const resamplers = new Map<VoiceInputSource, ReturnType<typeof createPcmResampler>>();
  let clientSampleRate = outputSampleRate;
  let messageChain: Promise<void> = Promise.resolve();

  let assistantTurn:
    | {
        turnId: string;
        abort: AbortController;
        state: 'thinking' | 'speaking';
      }
    | null = null;

  const sttControllers = new Map<VoiceInputSource, StreamingController>();
  const sttPendings = new Map<VoiceInputSource, Promise<void>>();
  let realtimePending: Promise<void> | null = null;

  let realtimeSession: OpenAiRealtimeVoiceSession | null = null;
  let realtimeActive:
    | {
        responseId: string;
        turnId: string;
        createdAtMs: number;
        audioStarted: boolean;
        audioEndSent: boolean;
        audioDone: boolean;
        audioItemId?: string;
        audioBytesSent: number;
        cancelReason?: 'barge_in' | 'stopped';
        ignoreOutput?: boolean;
        assistantTextSent: boolean;
        assistantTextDone: boolean;
      }
    | null = null;

  const sendJson = (payload: VoiceServerMessage | { type: 'ping'; ts: number }) => {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // ignore send failures; close handlers will clean up
    }
  };

  const sendState = (state: VoiceState, turnId?: string) => {
    voiceState = state;
    const msg: VoiceStateMessage = { type: 'voice_state', state, ts: Date.now(), turnId };
    sendJson(msg);
  };

  const sendAudioStart = (turnId: string, metrics?: { llmMs?: number; ttsTtfbMs?: number }) => {
    const msg: VoiceAssistantAudioStartMessage = {
      type: 'voice_assistant_audio_start',
      turnId,
      timestamp: Date.now(),
      llmMs: metrics?.llmMs,
      ttsTtfbMs: metrics?.ttsTtfbMs,
    };
    sendJson(msg);
  };

  const sendAudioEnd = (turnId: string, reason?: VoiceAssistantAudioEndMessage['reason']) => {
    const msg: VoiceAssistantAudioEndMessage = {
      type: 'voice_assistant_audio_end',
      turnId,
      timestamp: Date.now(),
      reason,
    };
    sendJson(msg);
  };

  const stopAssistant = (
    reason: 'barge_in' | 'stopped' | 'error',
    opts?: { playedMs?: number; cancelRealtime?: boolean }
  ) => {
    if (presetMode === 'openai_realtime') {
      const active = realtimeActive;
      if (!active) {
        sendState('listening');
        return;
      }

      const endReason: VoiceAssistantAudioEndMessage['reason'] =
        reason === 'barge_in' ? 'barge_in' : reason === 'stopped' ? 'stopped' : 'error';

      active.cancelReason = reason === 'barge_in' ? 'barge_in' : reason === 'stopped' ? 'stopped' : active.cancelReason;
      active.ignoreOutput = true;

      // Best-effort truncate so the conversation state matches what the user actually heard.
      if (active.audioItemId && active.audioBytesSent > 0) {
        const maxAudioEndMs = (active.audioBytesSent / (openAiRealtimeSampleRate * 2)) * 1000;
        const playedMs = opts?.playedMs;
        const audioEndMs =
          typeof playedMs === 'number' && Number.isFinite(playedMs)
            ? Math.min(Math.max(0, playedMs), maxAudioEndMs)
            : maxAudioEndMs;
        void realtimeSession
          ?.truncateOutputAudio(active.audioItemId, audioEndMs)
          .catch((err) => logger.warn({ event: 'openai_realtime_truncate_failed', message: (err as Error).message }));
      }

      const shouldCancel = opts?.cancelRealtime !== false && reason !== 'error';
      if (shouldCancel) {
        void realtimeSession
          ?.cancelResponse()
          .catch((err) => logger.warn({ event: 'openai_realtime_cancel_failed', message: (err as Error).message }));
      }

      if (active.audioStarted && !active.audioEndSent) {
        sendAudioEnd(active.turnId, endReason);
        active.audioEndSent = true;
      }

      sendState('listening');
      return;
    }

    const active = assistantTurn;
    if (!active) return;
    try {
      active.abort.abort();
    } catch {
      // ignore
    }
    const preserveSuppressed = reason === 'barge_in' && active.state === 'speaking';
    if (!preserveSuppressed) {
      clearSuppressedTranscripts();
    }
    if (active.state === 'speaking') {
      sendAudioEnd(active.turnId, reason);
    }
    assistantTurn = null;
    sendState('listening');
  };

  const scheduleFinalize = () => {
    if (finalizeTimer) clearTimeout(finalizeTimer);
    finalizeTimer = setTimeout(() => {
      void finalizeUserTurn();
    }, finalizeDelayMs);
  };

  const applySuppressedTranscripts = () => {
    if (suppressedFinalParts.length === 0 && !suppressedInterim) return;
    if (suppressedFinalParts.length > 0) {
      const parts = suppressedFinalParts.splice(0);
      let shouldFinalize = false;
      for (const part of parts) {
        const msg: VoiceUserTranscriptMessage = {
          type: 'voice_user_transcript',
          isFinal: true,
          text: part.text,
          timestamp: Date.now(),
          source: part.source,
        };
        sendJson(msg);
        if (maybeEnqueueFinalPart(part.source, part.text)) {
          shouldFinalize = true;
        }
      }
      if (shouldFinalize) {
        scheduleFinalize();
      }
    } else if (suppressedInterim) {
      const msg: VoiceUserTranscriptMessage = {
        type: 'voice_user_transcript',
        isFinal: false,
        text: suppressedInterim.text,
        timestamp: Date.now(),
        source: suppressedInterim.source,
      };
      sendJson(msg);
    }
    clearSuppressedTranscripts();
  };

  const finalizeUserTurn = async () => {
    if (closed) return;
    if (assistantTurn) return;
    const text = pendingFinalParts.join(' ').trim();
    pendingFinalParts.length = 0;
    if (!text) return;

    const abort = new AbortController();
    const turnId = randomUUID();
    assistantTurn = { turnId, abort, state: 'thinking' };
    sendState('thinking', turnId);
    const isActiveTurn = () => assistantTurn?.turnId === turnId;

    history.push({ role: 'user', content: text });
    trimHistory();

    try {
      const llmStart = Date.now();
      const assistantText = await generateChatReply(history, {
        signal: abort.signal,
      });
      const llmMs = Date.now() - llmStart;

      if (abort.signal.aborted || closed) {
        return;
      }
      if (!isActiveTurn()) {
        return;
      }
      if (!ttsProvider) {
        throw new Error('voice session is not initialized (missing tts provider)');
      }

      history.push({ role: 'assistant', content: assistantText });
      trimHistory();
      const textMsg: VoiceAssistantTextMessage = {
        type: 'voice_assistant_text',
        turnId,
        text: assistantText,
        isFinal: true,
        timestamp: Date.now(),
      };
      sendJson(textMsg);

      const ttsStart = Date.now();
      let ttsTtfbMs: number | null = null;
      let audioChunks = 0;
      let audioBytes = 0;
      let startedSpeaking = false;

      const ttsStream =
        ttsProvider === 'openai'
          ? streamOpenAiTtsPcm(assistantText, { signal: abort.signal, sampleRate: outputSampleRate })
          : streamTtsPcm(assistantText, { signal: abort.signal, lang, sampleRate: outputSampleRate });

      for await (const pcm of ttsStream) {
        if (abort.signal.aborted || closed) break;
        if (!isActiveTurn()) break;
        if (!startedSpeaking) {
          startedSpeaking = true;
          ttsTtfbMs = Date.now() - ttsStart;
          clearSuppressedTranscripts();
          assistantTurn = { turnId, abort, state: 'speaking' };
          sendState('speaking', turnId);
          sendAudioStart(turnId, { llmMs, ttsTtfbMs });
        }
        try {
          ws.send(pcm);
          audioChunks += 1;
          audioBytes += pcm.length;
        } catch {
          break;
        }
      }

      if (!abort.signal.aborted && !closed && isActiveTurn() && startedSpeaking) {
        sendAudioEnd(turnId, 'completed');
      }

      if (!abort.signal.aborted && !closed && isActiveTurn()) {
        logger.info({
          event: 'voice_turn_metrics',
          sessionId,
          turnId,
          presetId: presetId ?? undefined,
          sttProvider: sttProvider ?? undefined,
          ttsProvider: ttsProvider ?? undefined,
          lang,
          llmMs,
          ttsTtfbMs,
          ttsMs: Date.now() - ttsStart,
          audioChunks,
          audioBytes,
          outputSampleRate,
        });
      }
    } catch (err) {
      if (abort.signal.aborted || closed) {
        return;
      }
      if (!isActiveTurn()) {
        return;
      }
      const message = err instanceof Error ? err.message : 'voice agent error';
      logger.error({ event: 'voice_agent_error', message });
      if (assistantTurn?.state === 'speaking') {
        sendAudioEnd(turnId, 'error');
      }
      sendJson({ type: 'error', message });
    } finally {
      if (isActiveTurn()) {
        assistantTurn = null;
        clearSuppressedTranscripts();
        if (!closed) {
          sendState('listening');
        }
      }
    }
  };

  const ensureResampler = (source: VoiceInputSource, inputSampleRate: number) => {
    if (inputSampleRate === outputSampleRate) return null;
    const existing = resamplers.get(source);
    if (existing) return existing;
    const created = createPcmResampler({
      inputSampleRate,
      outputSampleRate,
      channels: 1,
    });
    created.onChunk((chunk) => {
      void sendAudioToBackend(source, chunk);
    });
    created.onError((err) => handleFatal(err));
    created.onClose((code) => {
      if (closed) return;
      if (typeof code === 'number' && code !== 0) {
        handleFatal(new Error(`ffmpeg exited with code ${code}`));
      }
    });
    resamplers.set(source, created);
    return created;
  };

  async function sendToStt(source: VoiceInputSource, pcm: Buffer) {
    const controller = sttControllers.get(source);
    if (!controller) return;
    const prev = sttPendings.get(source) ?? Promise.resolve();
    const sendPromise = prev
      .then(async () => {
        await controller.sendAudio(bufferToArrayBuffer(pcm));
      })
      .catch((err) => handleFatal(err as Error));
    sttPendings.set(source, sendPromise);
    await sendPromise;
  }

  async function sendToRealtime(pcm: Buffer) {
    if (!realtimeSession) return;
    const sendPromise = (realtimePending ?? Promise.resolve())
      .then(async () => {
        await realtimeSession?.appendAudio(pcm);
      })
      .catch((err) => handleFatal(err as Error));
    realtimePending = sendPromise;
    await sendPromise;
  }

  async function sendAudioToBackend(source: VoiceInputSource, pcm: Buffer) {
    if (presetMode === 'openai_realtime') {
      await sendToRealtime(pcm);
      return;
    }
    await sendToStt(source, pcm);
  }

  function handleFatal(err: Error) {
    if (closed) return;
    closed = true;
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    stopAssistant('error');
    sendJson({ type: 'error', message: err.message });
    ws.close();
  }

  let meetingModeEnabled = false;
  let meetingRequireWakeWord = false;
  let wakeWords: string[] = [];
  let wakeWordMatchers: Array<{ kind: 'boundary'; pattern: RegExp } | { kind: 'includes'; token: string }> = [];

  const matchesWakeWord = (text: string) => {
    if (wakeWordMatchers.length === 0) return false;
    const lower = text.toLowerCase();
    return wakeWordMatchers.some((matcher) => {
      if (matcher.kind === 'boundary') return matcher.pattern.test(text);
      return matcher.token.length > 0 && lower.includes(matcher.token);
    });
  };

  const meetingSystemPromptSuffix =
    '\n\nあなたはWeb会議に参加しています。ユーザー発話には [me] (このPCのマイク) と [meeting] (会議タブ音声) のラベルが付くことがあります。会議の妨げにならないよう、簡潔に返答してください。';

  const applyMeetingSystemPrompt = () => {
    if (!meetingModeEnabled) return;
    const currentSystem = history[0]?.content ?? systemPrompt;
    history[0] = {
      role: 'system',
      content: currentSystem.includes('あなたはWeb会議に参加しています。')
        ? currentSystem
        : `${currentSystem}${meetingSystemPromptSuffix}`,
    };
  };

  const formatHistoryText = (source: VoiceInputSource, text: string, meetingMode: boolean) => {
    if (!meetingMode) return text;
    return source === 'meeting' ? `[meeting] ${text}` : `[me] ${text}`;
  };

  const maybeEnqueueFinalPart = (source: VoiceInputSource, text: string) => {
    if (!text) return false;
    const gated = source === 'meeting' && meetingRequireWakeWord && !matchesWakeWord(text);
    if (gated) return false;
    const cleaned = source === 'meeting' && meetingRequireWakeWord ? stripWakeWord(text, wakeWords) : text;
    pendingFinalParts.push(formatHistoryText(source, cleaned, meetingModeEnabled));
    return true;
  };

  const startOrRestartRealtimeSession = async () => {
    const prev = realtimeSession;
    realtimeSession = null;
    realtimeActive = null;
    realtimePending = null;
    await prev?.close().catch(() => undefined);

    const realtime = startOpenAiRealtimeVoiceSession(
      {
        lang,
        systemPrompt,
      },
      {
        onSpeechStarted: () => {
          if (closed) return;
          if (voiceState === 'speaking') {
            stopAssistant('barge_in', { cancelRealtime: false });
          }
        },
        onUserTranscript: ({ text, isFinal }) => {
          if (closed) return;
          const trimmed = text.trim();
          if (!trimmed) return;
          const msgPayload: VoiceUserTranscriptMessage = {
            type: 'voice_user_transcript',
            isFinal,
            text: trimmed,
            timestamp: Date.now(),
            source: 'mic',
          };
          sendJson(msgPayload);
        },
        onResponseCreated: ({ responseId }) => {
          if (closed) return;
          // Close out any in-flight turn container so the UI doesn't get stuck.
          if (realtimeActive?.audioStarted && !realtimeActive.audioEndSent) {
            realtimeActive.audioEndSent = true;
            sendAudioEnd(realtimeActive.turnId, realtimeActive.cancelReason ?? 'stopped');
          }
          const turnId = randomUUID();
          realtimeActive = {
            responseId,
            turnId,
            createdAtMs: Date.now(),
            audioStarted: false,
            audioEndSent: false,
            audioDone: false,
            audioBytesSent: 0,
            ignoreOutput: false,
            assistantTextSent: false,
            assistantTextDone: false,
          };
          sendState('thinking', turnId);
        },
        onResponseDone: ({ responseId, status }) => {
          if (closed) return;
          const active = realtimeActive;
          if (!active || active.responseId !== responseId) return;

          const normalizedStatus = (status ?? '').toLowerCase();
          const reason: VoiceAssistantAudioEndMessage['reason'] =
            active.cancelReason ??
            (normalizedStatus === 'failed' || normalizedStatus === 'incomplete'
              ? 'error'
              : normalizedStatus === 'cancelled'
                ? 'stopped'
                : 'completed');

          if (active.audioStarted && !active.audioEndSent) {
            active.audioEndSent = true;
            sendAudioEnd(active.turnId, reason);
          }
          sendState('listening');
          realtimeActive = null;
        },
        onAssistantAudioDelta: ({ responseId, itemId, pcm }) => {
          if (closed) return;
          let active = realtimeActive;
          if (!active) {
            // Fallback: if we missed response.created, synthesize a turn container.
            const turnId = randomUUID();
            active = {
              responseId,
              turnId,
              createdAtMs: Date.now(),
              audioStarted: false,
              audioEndSent: false,
              audioDone: false,
              audioBytesSent: 0,
              ignoreOutput: false,
              assistantTextSent: false,
              assistantTextDone: false,
            };
            realtimeActive = active;
            sendState('thinking', turnId);
          }
          if (active.responseId !== responseId) return;
          if (active.ignoreOutput) return;

          if (itemId && !active.audioItemId) {
            active.audioItemId = itemId;
          }

          if (!active.audioStarted) {
            active.audioStarted = true;
            const ttsTtfbMs = Date.now() - active.createdAtMs;
            clearSuppressedTranscripts();
            sendState('speaking', active.turnId);
            sendAudioStart(active.turnId, { ttsTtfbMs });
          }

          try {
            ws.send(pcm);
            active.audioBytesSent += pcm.length;
          } catch {
            // ignore send failures; close handlers will clean up
          }
        },
        onAssistantAudioDone: ({ responseId }) => {
          if (closed) return;
          const active = realtimeActive;
          if (!active || active.responseId !== responseId) return;

          active.audioDone = true;
          if (active.audioStarted && !active.audioEndSent) {
            active.audioEndSent = true;
            sendAudioEnd(active.turnId, active.cancelReason ?? 'completed');
          }
          sendState('listening');

          if (active.assistantTextDone) {
            realtimeActive = null;
          }
        },
        onAssistantTextDone: ({ responseId, text }) => {
          if (closed) return;
          const active = realtimeActive;
          if (!active || active.responseId !== responseId) return;
          if (active.ignoreOutput) return;
          const trimmed = text.trim();
          if (!trimmed) return;
          if (!active.assistantTextSent) {
            active.assistantTextSent = true;
            const textMsg: VoiceAssistantTextMessage = {
              type: 'voice_assistant_text',
              turnId: active.turnId,
              text: trimmed,
              isFinal: true,
              timestamp: Date.now(),
            };
            sendJson(textMsg);
          }
          active.assistantTextDone = true;
          if (active.audioDone) {
            realtimeActive = null;
          }
        },
        onError: (err) => handleFatal(err),
        onClose: () => {
          if (closed) return;
          handleFatal(new Error('openai realtime voice session closed'));
        },
      }
    );

    realtimeSession = realtime;
    await realtime.ready;
  };

  const startStt = async (msg: VoiceConfigMessage) => {
    clientSampleRate = msg.clientSampleRate;
    finalizeDelayMs = msg.options?.finalizeDelayMs ?? finalizeDelayMs;
    const enableInterim = msg.enableInterim !== false;

    const preset = resolveVoicePreset(config, msg.presetId);
    if (!preset.available) {
      const detail = [...preset.missingEnv, ...preset.issues].filter(Boolean).join(', ');
      throw new Error(`voice preset unavailable (${preset.id}): ${detail || 'unknown reason'}`);
    }

    presetId = preset.id;
    presetMode = preset.mode;
    const selectedSttProvider = preset.providers.stt;
    const selectedTtsProvider = preset.providers.tts;
    sttProvider = selectedSttProvider;
    ttsProvider = selectedTtsProvider;

    meetingModeEnabled = msg.options?.meetingMode === true || (msg.channelSplit === true && msg.channels === 2);
    wakeWords = (msg.options?.wakeWords ?? []).map((w) => w.trim()).filter(Boolean);
    if (wakeWords.length === 0) {
      wakeWords = defaultWakeWords(lang);
    }
    wakeWordMatchers = wakeWords
      .map((w) => {
        const token = w.trim();
        if (!token) return null;
        const lowerToken = token.toLowerCase();
        // For ASCII tokens, require word boundaries (e.g., "ai" should not match "said").
        if (/^[a-z0-9]+$/i.test(token)) {
          return { kind: 'boundary' as const, pattern: new RegExp(`\\b${escapeRegExp(lowerToken)}\\b`, 'i') };
        }
        return { kind: 'includes' as const, token: lowerToken };
      })
      .filter((m): m is NonNullable<(typeof wakeWordMatchers)[number]> => Boolean(m));
    meetingRequireWakeWord = msg.options?.meetingRequireWakeWord ?? meetingModeEnabled;
    applyMeetingSystemPrompt();

    if (presetMode === 'openai_realtime') {
      if (msg.channelSplit) {
        throw new Error('openai_realtime preset does not support channelSplit; use pipeline presets for meeting mode');
      }
      if (selectedSttProvider !== 'openai' || selectedTtsProvider !== 'openai') {
        throw new Error('openai_realtime preset requires sttProvider=openai and ttsProvider=openai');
      }

      outputSampleRate = openAiRealtimeSampleRate;
      await startOrRestartRealtimeSession();

      const sessionMsg: VoiceSessionMessage = {
        type: 'voice_session',
        sessionId,
        startedAt,
        presetId: presetId ?? undefined,
        mode: presetMode,
        inputSampleRate: clientSampleRate,
        outputAudioSpec: { sampleRate: outputSampleRate, channels: 1, format: 'pcm16le' },
        sttProvider: selectedSttProvider,
        llmProvider,
        ttsProvider: selectedTtsProvider,
      };
      sendJson(sessionMsg);
      sendState('listening');

      keepaliveTimer = setInterval(() => {
        if (closed) return;
        if (missedPongs >= maxMissedPongs) {
          handleFatal(new Error('voice keepalive timeout'));
          return;
        }
        missedPongs += 1;
        sendJson({ type: 'ping', ts: Date.now() });
      }, keepaliveMs);

      return;
    }

    // Align pipeline-mode input/output sample rate with the selected STT provider.
    // OpenAI realtime transcription expects 24 kHz mono PCM; others default to config.audio.targetSampleRate.
    outputSampleRate = getProviderSampleRate(selectedSttProvider, config);

    const adapter = getAdapter(selectedSttProvider);
    if (!adapter.supportsStreaming) {
      throw new Error(`voice STT provider does not support streaming: ${selectedSttProvider}`);
    }

    const useChannelSplit = meetingModeEnabled && msg.channelSplit === true && msg.channels === 2;
    const sources: VoiceInputSource[] = useChannelSplit ? ['mic', 'meeting'] : ['mic'];

    const handleSttTranscript = (source: VoiceInputSource, t: { isFinal: boolean; text: string; speakerId?: string }) => {
      if (closed) return;
      const text = t.text.trim();

      // If the user starts talking while the assistant is still thinking, abort the in-flight turn.
      if (assistantTurn?.state === 'thinking' && text) {
        stopAssistant('barge_in');
      }

      if (voiceState === 'speaking') {
        if (t.isFinal) {
          if (text) suppressedFinalParts.push({ source, text });
        } else {
          suppressedInterim = text.length > 0 ? { source, text } : suppressedInterim;
        }
        return;
      }

      const msgPayload: VoiceUserTranscriptMessage = {
        type: 'voice_user_transcript',
        isFinal: t.isFinal,
        text,
        timestamp: Date.now(),
        source,
        speakerId: t.speakerId,
      };
      if (text) {
        sendJson(msgPayload);
      }
      if (t.isFinal && text) {
        if (maybeEnqueueFinalPart(source, text)) {
          scheduleFinalize();
        }
      }
    };

    await Promise.all(
      sources.map(async (source) => {
        const sttSession = await adapter.startStreaming({
          language: lang,
          sampleRateHz: outputSampleRate,
          encoding: 'linear16',
          enableInterim,
          enableVad: true,
        });
        sttControllers.set(source, sttSession.controller);
        sttSession.onData((t) => handleSttTranscript(source, t));
        sttSession.onError((err) => handleFatal(err));
        sttSession.onClose(() => {
          if (closed) return;
          ws.close();
        });
      })
    );

    const sessionMsg: VoiceSessionMessage = {
      type: 'voice_session',
      sessionId,
      startedAt,
      presetId: presetId ?? undefined,
      mode: presetMode,
      inputSampleRate: clientSampleRate,
      outputAudioSpec: { sampleRate: outputSampleRate, channels: 1, format: 'pcm16le' },
      sttProvider: selectedSttProvider,
      llmProvider,
      ttsProvider: selectedTtsProvider,
    };
    sendJson(sessionMsg);
    sendState('listening');

    keepaliveTimer = setInterval(() => {
      if (closed) return;
      if (missedPongs >= maxMissedPongs) {
        handleFatal(new Error('voice keepalive timeout'));
        return;
      }
      missedPongs += 1;
      sendJson({ type: 'ping', ts: Date.now() });
    }, keepaliveMs);
  };

  const handleCommand = async (msg: VoiceCommandMessage) => {
    if (msg.name === 'reset_history') {
      const hadAssistant = assistantTurn !== null || realtimeActive !== null;
      stopAssistant('stopped', { playedMs: msg.playedMs });
      history.length = 0;
      history.push({ role: 'system', content: systemPrompt });
      applyMeetingSystemPrompt();
      pendingFinalParts.length = 0;
      clearSuppressedTranscripts();
      if (presetMode === 'openai_realtime') {
        await startOrRestartRealtimeSession();
      }
      if (!hadAssistant) {
        sendState('listening');
      }
      return;
    }

    if (msg.name === 'stop_speaking') {
      stopAssistant('stopped', { playedMs: msg.playedMs });
      return;
    }

    if (msg.name === 'barge_in') {
      stopAssistant('barge_in', { playedMs: msg.playedMs });
      applySuppressedTranscripts();
    }
  };

  ws.on('message', (data, isBinary) => {
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

    const run = async () => {
      if (closed) return;
      if (!sessionStarted && isBinary) {
        sendJson({ type: 'error', message: 'config message required before audio' });
        ws.close();
        return;
      }
      if (!sessionStarted && !isBinary) {
        try {
          const parsed = JSON.parse(data.toString());
          const cfg = voiceConfigMessageSchema.parse(parsed) as VoiceConfigMessage;
          sessionStarted = true;
          await startStt(cfg);
          return;
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Invalid initial config message';
          sendJson({ type: 'error', message });
          ws.close();
          return;
        }
      }

      if (!isBinary) {
        try {
          const parsed = JSON.parse(data.toString());
          const cmd = voiceCommandMessageSchema.parse(parsed) as VoiceCommandMessage;
          await handleCommand(cmd);
        } catch {
          // ignore unknown messages
        }
        return;
      }

      const buffer = normalizeRawData(data);
      try {
        const { header, pcm } = parseStreamFrame(buffer);
        const source: VoiceInputSource =
          meetingModeEnabled && sttControllers.has('meeting') ? (header.seq % 2 === 0 ? 'mic' : 'meeting') : 'mic';
        const resample = ensureResampler(source, clientSampleRate);
        if (resample) {
          await resample.input(pcm, {
            captureTs: header.captureTs,
            durationMs: header.durationMs,
            seq: header.seq,
          });
          return;
        }
        await sendAudioToBackend(source, pcm);
      } catch (err) {
        handleFatal(err as Error);
      }
    };
    if (closed) return;
    messageChain = messageChain.then(run).catch((err) => {
      handleFatal(err as Error);
    });
  });

  ws.on('close', () => {
    closed = true;
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    if (finalizeTimer) {
      clearTimeout(finalizeTimer);
      finalizeTimer = null;
    }
    stopAssistant('stopped');
    resamplers.forEach((r) => r.end());
    void (async () => {
      await Promise.allSettled(Array.from(sttPendings.values()).map(async (p) => p.catch(() => undefined)));
      await Promise.allSettled(Array.from(sttControllers.values()).map(async (c) => c.end().catch(() => undefined)));
      await Promise.allSettled(Array.from(sttControllers.values()).map(async (c) => c.close().catch(() => undefined)));
      await realtimePending?.catch(() => undefined);
      await realtimeSession?.close().catch(() => undefined);
      realtimeSession = null;
      realtimeActive = null;
    })();
  });

  ws.on('error', (err) => {
    logger.error({ event: 'voice_ws_error', message: err.message });
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
