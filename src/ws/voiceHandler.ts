import type { RawData, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config.js';
import { getAdapter } from '../adapters/index.js';
import { logger } from '../logger.js';
import { bufferToArrayBuffer } from '../utils/buffer.js';
import { parseStreamFrame } from '../utils/streamHeader.js';
import { createPcmResampler } from '../utils/ffmpeg.js';
import { voiceCommandMessageSchema, voiceConfigMessageSchema } from '../validation.js';
import type {
  ProviderId,
  VoiceAssistantAudioEndMessage,
  VoiceAssistantAudioStartMessage,
  VoiceAssistantTextMessage,
  VoiceCommandMessage,
  VoiceConfigMessage,
  VoiceServerMessage,
  VoiceSessionMessage,
  VoiceState,
  VoiceStateMessage,
  VoiceUserTranscriptMessage,
} from '../types.js';
import { generateChatReply } from '../voice/openaiChat.js';
import { streamTtsPcm } from '../voice/elevenlabsTts.js';

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

export async function handleVoiceConnection(ws: WebSocket, lang: string) {
  const config = await loadConfig();
  const sessionId = randomUUID();
  const startedAt = new Date().toISOString();
  const keepaliveMs = config.ws?.keepaliveMs ?? 30_000;
  const maxMissedPongs = config.ws?.maxMissedPongs ?? 2;
  const outputSampleRate = config.audio.targetSampleRate ?? 16_000;
  const sttProvider: ProviderId = 'elevenlabs';
  const ttsProvider: ProviderId = 'elevenlabs';
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
  let suppressedInterim: string | null = null;
  const suppressedFinalParts: string[] = [];
  const clearSuppressedTranscripts = () => {
    suppressedInterim = null;
    suppressedFinalParts.length = 0;
  };

  let resampler: ReturnType<typeof createPcmResampler> | null = null;
  let clientSampleRate = outputSampleRate;
  let messageChain: Promise<void> = Promise.resolve();

  let assistantTurn:
    | {
        turnId: string;
        abort: AbortController;
        state: 'thinking' | 'speaking';
      }
    | null = null;

  const adapter = getAdapter(sttProvider);
  let sttController: Awaited<ReturnType<typeof adapter.startStreaming>>['controller'] | null = null;
  let sttPending: Promise<void> | null = null;

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

  const stopAssistant = (reason: 'barge_in' | 'stopped' | 'error') => {
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
      pendingFinalParts.push(...suppressedFinalParts.splice(0));
      scheduleFinalize();
    } else if (suppressedInterim) {
      const msg: VoiceUserTranscriptMessage = {
        type: 'voice_user_transcript',
        isFinal: false,
        text: suppressedInterim,
        timestamp: Date.now(),
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
        lang,
        signal: abort.signal,
      });
      const llmMs = Date.now() - llmStart;

      if (abort.signal.aborted || closed) {
        return;
      }
      if (!isActiveTurn()) {
        return;
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

      for await (const pcm of streamTtsPcm(assistantText, {
        signal: abort.signal,
        lang,
        sampleRate: outputSampleRate,
      })) {
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

  const ensureResampler = (inputSampleRate: number) => {
    if (inputSampleRate === outputSampleRate) return null;
    if (resampler) return resampler;
    const created = createPcmResampler({
      inputSampleRate,
      outputSampleRate,
      channels: 1,
    });
    created.onChunk((chunk) => {
      void sendToStt(chunk);
    });
    created.onError((err) => handleFatal(err));
    created.onClose((code) => {
      if (closed) return;
      if (typeof code === 'number' && code !== 0) {
        handleFatal(new Error(`ffmpeg exited with code ${code}`));
      }
    });
    resampler = created;
    return created;
  };

  const sendToStt = async (pcm: Buffer) => {
    if (!sttController) return;
    const sendPromise = (sttPending ?? Promise.resolve())
      .then(async () => {
        await sttController?.sendAudio(bufferToArrayBuffer(pcm));
      })
      .catch((err) => handleFatal(err as Error));
    sttPending = sendPromise;
    await sendPromise;
  };

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

  const startStt = async (msg: VoiceConfigMessage) => {
    clientSampleRate = msg.clientSampleRate;
    finalizeDelayMs = msg.options?.finalizeDelayMs ?? finalizeDelayMs;
    const enableInterim = msg.enableInterim !== false;
    const sttSession = await adapter.startStreaming({
      language: lang,
      sampleRateHz: outputSampleRate,
      encoding: 'linear16',
      enableInterim,
      enableVad: true,
    });
    sttController = sttSession.controller;

    sttSession.onData((t) => {
      if (closed) return;
      const text = t.text.trim();

      // If the user starts talking while the assistant is still thinking, abort the in-flight turn.
      if (assistantTurn?.state === 'thinking' && text) {
        stopAssistant('barge_in');
      }

      if (voiceState === 'speaking') {
        if (t.isFinal) {
          if (text) suppressedFinalParts.push(text);
        } else {
          suppressedInterim = text.length > 0 ? text : suppressedInterim;
        }
        return;
      }

      const msgPayload: VoiceUserTranscriptMessage = {
        type: 'voice_user_transcript',
        isFinal: t.isFinal,
        text,
        timestamp: Date.now(),
      };
      if (text) {
        sendJson(msgPayload);
      }
      if (t.isFinal && text) {
        pendingFinalParts.push(text);
        scheduleFinalize();
      }
    });
    sttSession.onError((err) => handleFatal(err));
    sttSession.onClose(() => {
      if (closed) return;
      ws.close();
    });

    const sessionMsg: VoiceSessionMessage = {
      type: 'voice_session',
      sessionId,
      startedAt,
      inputSampleRate: clientSampleRate,
      outputAudioSpec: { sampleRate: outputSampleRate, channels: 1, format: 'pcm16le' },
      sttProvider,
      llmProvider,
      ttsProvider,
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

  const handleCommand = (msg: VoiceCommandMessage) => {
    if (msg.name === 'reset_history') {
      history.length = 0;
      history.push({ role: 'system', content: systemPrompt });
      pendingFinalParts.length = 0;
      clearSuppressedTranscripts();
      sendState('listening');
      return;
    }

    if (msg.name === 'stop_speaking') {
      stopAssistant('stopped');
      return;
    }

    if (msg.name === 'barge_in') {
      stopAssistant('barge_in');
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
          handleCommand(cmd);
        } catch {
          // ignore unknown messages
        }
        return;
      }

      const buffer = normalizeRawData(data);
      try {
        const { header, pcm } = parseStreamFrame(buffer);
        const resample = ensureResampler(clientSampleRate);
        if (resample) {
          await resample.input(pcm, {
            captureTs: header.captureTs,
            durationMs: header.durationMs,
            seq: header.seq,
          });
          return;
        }
        await sendToStt(pcm);
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
    resampler?.end();
    void (async () => {
      await sttPending?.catch(() => undefined);
      await sttController?.end().catch(() => undefined);
      await sttController?.close().catch(() => undefined);
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
