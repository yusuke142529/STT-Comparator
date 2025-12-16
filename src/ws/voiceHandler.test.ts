import { describe, expect, it, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

describe('handleVoiceConnection', () => {
  class FakeWebSocket extends EventEmitter {
    sent: Array<string | Buffer> = [];
    closed = false;
    send(data: string | Buffer) {
      this.sent.push(data);
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.emit('close');
    }
  }

  const state = vi.hoisted(() => {
    let onDataHandler: ((t: any) => void) | null = null;
    let chatQueue: Array<() => Promise<string>> = [];
    const chatSignals: AbortSignal[] = [];
    const chatSnapshots: unknown[] = [];
    const controller = {
      sendAudio: vi.fn(async () => {}),
      end: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const generateChatReply = vi.fn(async (_messages: unknown, opts?: { signal?: AbortSignal }) => {
      if (Array.isArray(_messages)) {
        chatSnapshots.push(_messages.map((m) => (m && typeof m === 'object' ? { ...(m as any) } : m)));
      } else {
        chatSnapshots.push(_messages);
      }
      if (opts?.signal) chatSignals.push(opts.signal);
      const next = chatQueue.shift();
      if (next) return await next();
      return '了解しました。';
    });
    return {
      controller,
      setOnData: (cb: (t: any) => void) => {
        onDataHandler = cb;
      },
      getOnData: () => onDataHandler,
      setChatQueue: (queue: Array<() => Promise<string>>) => {
        chatQueue = [...queue];
      },
      getChatSignals: () => chatSignals.slice(),
      getChatSnapshots: () => chatSnapshots.slice(),
      generateChatReply,
      reset: () => {
        onDataHandler = null;
        chatQueue = [];
        chatSignals.length = 0;
        chatSnapshots.length = 0;
      },
    };
  });

  vi.mock('../config.js', () => ({
    loadConfig: vi.fn().mockResolvedValue({
      audio: { targetSampleRate: 16000, targetChannels: 1, chunkMs: 250 },
      normalization: {},
      storage: { driver: 'jsonl', path: './runs' },
      providers: ['elevenlabs'],
      ws: { keepaliveMs: 1000, maxMissedPongs: 2 },
    }),
  }));

  vi.mock('../adapters/index.js', () => ({
    getAdapter: vi.fn(() => ({
      id: 'elevenlabs',
      supportsStreaming: true,
      supportsBatch: true,
      startStreaming: vi.fn(async () => ({
        controller: state.controller,
        onData: (cb: (t: any) => void) => state.setOnData(cb),
        onError: () => {},
        onClose: () => {},
      })),
      transcribeFileFromPCM: vi.fn(),
    })),
  }));

  vi.mock('../voice/openaiChat.js', () => ({
    generateChatReply: state.generateChatReply,
  }));

  vi.mock('../voice/elevenlabsTts.js', () => ({
    streamTtsPcm: vi.fn(async function* (_text: string, opts: { signal?: AbortSignal }) {
      yield Buffer.from([1, 2, 3, 4]);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 1000);
        opts.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          resolve();
        });
      });
      if (opts.signal?.aborted) return;
      yield Buffer.from([5, 6, 7, 8]);
    }),
  }));

  afterEach(() => {
    state.reset();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  const parseJsonMessages = (ws: FakeWebSocket) =>
    ws.sent
      .filter((m): m is string => typeof m === 'string')
      .map((m) => JSON.parse(m));

  const flushMicrotasks = async (max = 10) => {
    for (let i = 0; i < max; i += 1) {
      await Promise.resolve();
    }
  };

  it('starts session and produces assistant audio for a committed transcript', async () => {
    vi.useFakeTimers();
    const { handleVoiceConnection } = await import('./voiceHandler.js');
    const ws = new FakeWebSocket();

    await handleVoiceConnection(ws as any, 'ja-JP');
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'config', pcm: true, clientSampleRate: 16000, options: { finalizeDelayMs: 0 } })), false);

    for (let i = 0; i < 5 && !state.getOnData(); i += 1) {
      await Promise.resolve();
    }

    state.getOnData()?.({ isFinal: true, text: 'こんにちは', provider: 'elevenlabs' });
    vi.runOnlyPendingTimers();
    await flushMicrotasks();
    vi.advanceTimersByTime(1000);
    await flushMicrotasks();

    const json = parseJsonMessages(ws);
    expect(json.some((m) => m.type === 'voice_session')).toBe(true);
    expect(json.some((m) => m.type === 'voice_user_transcript' && m.isFinal === true)).toBe(true);
    expect(json.some((m) => m.type === 'voice_assistant_text' && m.isFinal === true)).toBe(true);
    expect(json.some((m) => m.type === 'voice_assistant_audio_start')).toBe(true);
    expect(json.some((m) => m.type === 'voice_assistant_audio_end' && m.reason === 'completed')).toBe(true);
    const audioStart = json.find((m) => m.type === 'voice_assistant_audio_start');
    expect(typeof audioStart?.llmMs).toBe('number');
    expect(typeof audioStart?.ttsTtfbMs).toBe('number');

    const binaries = ws.sent.filter((m): m is Buffer => Buffer.isBuffer(m));
    expect(binaries.length).toBeGreaterThanOrEqual(1);
  });

  it('supports barge-in by aborting assistant speech', async () => {
    vi.useFakeTimers();
    const { handleVoiceConnection } = await import('./voiceHandler.js');
    const ws = new FakeWebSocket();

    await handleVoiceConnection(ws as any, 'ja-JP');
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'config', pcm: true, clientSampleRate: 16000, options: { finalizeDelayMs: 0 } })), false);

    for (let i = 0; i < 5 && !state.getOnData(); i += 1) {
      await Promise.resolve();
    }

    state.getOnData()?.({ isFinal: true, text: 'こんにちは', provider: 'elevenlabs' });
    vi.runOnlyPendingTimers();
    for (let i = 0; i < 5; i += 1) {
      await flushMicrotasks();
      const json = parseJsonMessages(ws);
      if (json.some((m) => m.type === 'voice_assistant_audio_start')) break;
    }

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'command', name: 'barge_in' })), false);
    vi.advanceTimersByTime(1000);
    await flushMicrotasks();

    const json = parseJsonMessages(ws);
    expect(json.some((m) => m.type === 'voice_assistant_audio_end' && m.reason === 'barge_in')).toBe(true);
  });

  it('aborts thinking turns without clobbering the next assistant turn', async () => {
    vi.useFakeTimers();
    const { handleVoiceConnection } = await import('./voiceHandler.js');
    const ws = new FakeWebSocket();

    let rejectFirst: ((err: Error) => void) | null = null;
    const firstChat = new Promise<string>((_resolve, reject) => {
      rejectFirst = reject;
    });
    state.setChatQueue([() => firstChat, async () => '次の返答です。']);

    await handleVoiceConnection(ws as any, 'ja-JP');
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({ type: 'config', pcm: true, clientSampleRate: 16000, options: { finalizeDelayMs: 0 } })
      ),
      false
    );

    for (let i = 0; i < 5 && !state.getOnData(); i += 1) {
      await Promise.resolve();
    }

    // Start the first turn -> it gets stuck "thinking" waiting on firstChat.
    state.getOnData()?.({ isFinal: true, text: '最初の質問', provider: 'elevenlabs' });
    vi.runOnlyPendingTimers();
    await flushMicrotasks();

    // While the assistant is thinking, user speaks again; this should abort the in-flight turn and start a new one.
    state.getOnData()?.({ isFinal: true, text: '追加の質問', provider: 'elevenlabs' });
    vi.runOnlyPendingTimers();
    await flushMicrotasks();

    for (let i = 0; i < 10; i += 1) {
      await flushMicrotasks();
      const json = parseJsonMessages(ws);
      if (json.some((m) => m.type === 'voice_assistant_audio_start')) break;
    }

    // Resolve the first (aborted) LLM call after the second turn has already started.
    rejectFirst?.(new Error('AbortError'));
    await flushMicrotasks();

    // Stop the second assistant speech; this must still work even if the first turn completes late.
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'command', name: 'stop_speaking' })), false);
    await flushMicrotasks();

    const json = parseJsonMessages(ws);
    expect(json.some((m) => m.type === 'voice_assistant_audio_start')).toBe(true);
    expect(json.some((m) => m.type === 'voice_assistant_audio_end' && m.reason === 'stopped')).toBe(true);

    const signals = state.getChatSignals();
    expect(signals.length).toBeGreaterThanOrEqual(2);
    expect(signals[0]?.aborted).toBe(true);
  });

  it('trims history to the configured max turns', async () => {
    vi.useFakeTimers();
    const prev = process.env.VOICE_HISTORY_MAX_TURNS;
    process.env.VOICE_HISTORY_MAX_TURNS = '1';
    vi.resetModules();
    try {
      const { handleVoiceConnection } = await import('./voiceHandler.js');
      const ws = new FakeWebSocket();

      await handleVoiceConnection(ws as any, 'ja-JP');
      ws.emit(
        'message',
        Buffer.from(
          JSON.stringify({ type: 'config', pcm: true, clientSampleRate: 16000, options: { finalizeDelayMs: 0 } })
        ),
        false
      );

      for (let i = 0; i < 5 && !state.getOnData(); i += 1) {
        await Promise.resolve();
      }

      state.getOnData()?.({ isFinal: true, text: '最初の発話', provider: 'elevenlabs' });
      vi.runOnlyPendingTimers();
      for (let i = 0; i < 10; i += 1) {
        await flushMicrotasks();
        const json = parseJsonMessages(ws);
        if (json.some((m) => m.type === 'voice_assistant_audio_start')) break;
      }

      ws.emit('message', Buffer.from(JSON.stringify({ type: 'command', name: 'stop_speaking' })), false);
      await flushMicrotasks();

      state.getOnData()?.({ isFinal: true, text: '次の発話', provider: 'elevenlabs' });
      vi.runOnlyPendingTimers();
      await flushMicrotasks();

      const snapshots = state.getChatSnapshots();
      expect(snapshots.length).toBeGreaterThanOrEqual(2);
      expect(Array.isArray(snapshots[1])).toBe(true);
      const second = snapshots[1] as Array<{ role: string; content: string }>;
      expect(second.length).toBe(2); // system + current user
      expect(second[1]?.role).toBe('user');
      expect(second[1]?.content).toBe('次の発話');
    } finally {
      if (prev === undefined) {
        delete process.env.VOICE_HISTORY_MAX_TURNS;
      } else {
        process.env.VOICE_HISTORY_MAX_TURNS = prev;
      }
    }
  });
});
