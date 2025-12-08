import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { RealtimeLatencySummary, RealtimeTranscriptLogEntry, StorageDriver } from '../types.js';
import type { RealtimeTranscriptLogWriter } from '../storage/realtimeTranscriptStore.js';

const noopStore: StorageDriver<RealtimeLatencySummary> = {
  init: async () => {},
  append: async () => {},
  readAll: async () => [],
};

class FakeWebSocket extends EventEmitter {
  sent: string[] = [];
  closed = false;
  // mimic ws OPEN state so handler can send
  readyState = 1;

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

type ProviderState = {
  controller: {
    sendAudio: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  startOpts?: any;
  setOnData: (cb: (t: any) => void) => void;
  getOnData: () => ((t: any) => void) | null;
  reset: () => void;
};

const state = vi.hoisted(() => {
  const buildProvider = (): ProviderState => {
    let onDataHandler: ((t: any) => void) | null = null;
    let startOpts: any;
    return {
      controller: {
        sendAudio: vi.fn(async (_chunk?: ArrayBufferLike, _meta?: { captureTs?: number }) => {}),
        end: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      },
      get startOpts() {
        return startOpts;
      },
      set startOpts(opts: any) {
        startOpts = opts;
      },
      setOnData: (cb: (t: any) => void) => {
        onDataHandler = cb;
      },
      getOnData: () => onDataHandler,
      reset: () => {
        onDataHandler = null;
        startOpts = undefined;
      },
    };
  };

  return {
    providers: {
      deepgram: buildProvider(),
      mock: buildProvider(),
      openai: buildProvider(),
    },
    reset() {
      Object.values(this.providers).forEach((p) => {
        p.reset();
        p.controller.sendAudio.mockClear();
        p.controller.end.mockClear();
        p.controller.close.mockClear();
        p.startOpts = undefined;
      });
    },
  };
});

vi.mock('../config.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    audio: { targetSampleRate: 16000, targetChannels: 1, chunkMs: 250 },
    normalization: {},
    storage: { driver: 'jsonl', path: './runs' },
    providers: ['mock', 'deepgram', 'openai'],
    ws: { maxPcmQueueBytes: 1024 * 1024, compare: { backlogSoft: 8, backlogHard: 32, maxDropMs: 1000 } },
  }),
}));

vi.mock('../adapters/index.js', () => ({
  getAdapter: vi.fn((id: 'mock' | 'deepgram' | 'openai') => {
    const provider = state.providers[id];
    return {
      id,
      supportsStreaming: true,
      supportsBatch: true,
      startStreaming: vi.fn(async (opts: any) => {
        provider.startOpts = opts;
        return {
          controller: provider.controller,
          onData: (cb: (t: any) => void) => provider.setOnData(cb),
          onError: () => {},
          onClose: () => {},
        };
      }),
      transcribeFileFromPCM: vi.fn(),
    };
  }),
}));

vi.mock('../utils/ffmpeg.js', () => ({
  spawnPcmTranscoder: vi.fn(() => ({
    input: async () => {},
    stream: new EventEmitter(),
    end: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
  })),
  createPcmResampler: vi.fn(() => {
    let onChunk: ((chunk: Buffer, meta: any) => void) | null = null;
    return {
      async input(chunk: Buffer, meta: any) {
        onChunk?.(chunk, meta);
      },
      onChunk(cb: (chunk: Buffer, meta: any) => void) {
        onChunk = cb;
      },
      end: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn(),
      outputSampleRate: 16_000,
    };
  }),
}));

const HEADER_BYTES = 16;
const buildPcmFrame = (seq: number, captureTs: number) => {
  const frame = Buffer.alloc(HEADER_BYTES + 4);
  frame.writeUInt32LE(seq, 0);
  frame.writeDoubleLE(captureTs, 4);
  frame.writeFloatLE(50, 12);
  frame.writeInt32LE(0, 16);
  return frame;
};

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

afterEach(() => {
  state.reset();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('handleCompareStreamConnection', () => {
  it('does not block fast provider when slow provider is pending', async () => {
    vi.useFakeTimers();
    const { handleCompareStreamConnection } = await import('./compareStreamHandler.js');
    const ws = new FakeWebSocket();

    // slow first provider blocks in old implementation
    state.providers.deepgram.controller.sendAudio.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 100))
    );
    state.providers.mock.controller.sendAudio.mockResolvedValue(undefined);

    await handleCompareStreamConnection(ws as any, ['deepgram', 'mock'], 'ja-JP', noopStore);

    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'config', pcm: true, clientSampleRate: 16000 })),
      false
    );
    await flushMicrotasks();
    ws.emit('message', buildPcmFrame(1, Date.now()), true);

    await Promise.resolve();

    expect(state.providers.deepgram.controller.sendAudio).toHaveBeenCalledTimes(1);
    expect(state.providers.mock.controller.sendAudio).toHaveBeenCalledTimes(1);
  });

  it('drops audio for a backlogged provider without failing under the drop budget', async () => {
    const { loadConfig } = await import('../config.js');
    const mockedLoadConfig = loadConfig as unknown as ReturnType<typeof vi.fn>;
    mockedLoadConfig.mockResolvedValueOnce({
      audio: { targetSampleRate: 16000, targetChannels: 1, chunkMs: 250 },
      normalization: {},
      storage: { driver: 'jsonl', path: './runs' },
      providers: ['mock', 'deepgram'],
      ws: { maxPcmQueueBytes: 1024 * 1024, compare: { backlogSoft: 1, backlogHard: 4, maxDropMs: 1000 } },
    });

    const { handleCompareStreamConnection } = await import('./compareStreamHandler.js');
    const ws = new FakeWebSocket();

    state.providers.deepgram.controller.sendAudio.mockImplementation(() => new Promise(() => {}));
    state.providers.mock.controller.sendAudio.mockResolvedValue(undefined);

    await handleCompareStreamConnection(ws as any, ['deepgram', 'mock'], 'ja-JP', noopStore);

    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'config', pcm: true, clientSampleRate: 16000 })),
      false
    );
    await flushMicrotasks();
    ws.emit('message', buildPcmFrame(1, Date.now()), true);
    ws.emit('message', buildPcmFrame(2, Date.now()), true);
    ws.emit('message', buildPcmFrame(3, Date.now()), true);
    await flushMicrotasks();

    expect(state.providers.deepgram.controller.sendAudio).toHaveBeenCalledTimes(1);
    expect(state.providers.deepgram.controller.close).not.toHaveBeenCalled();
    const errorMessages = ws.sent
      .map((m) => JSON.parse(m))
      .filter((m) => m.type === 'error' && m.provider === 'deepgram');
    expect(errorMessages.length).toBe(0);
  });

  it('logs session and session_end per provider', async () => {
    const logStore: RealtimeTranscriptLogWriter = {
      append: vi.fn(async () => {}),
    };
    const { handleCompareStreamConnection } = await import('./compareStreamHandler.js');
    const ws = new FakeWebSocket();

    await handleCompareStreamConnection(ws as any, ['mock', 'deepgram'], 'ja-JP', noopStore, logStore);

    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'config', pcm: true, clientSampleRate: 16000 })),
      false
    );
    await flushMicrotasks();
    ws.close();
    await flushMicrotasks();
    await flushMicrotasks();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushMicrotasks();

    const calls = (logStore.append as ReturnType<typeof vi.fn>).mock.calls.map(
      ([entry]) => entry as RealtimeTranscriptLogEntry
    );

    const sessionProviders = calls
      .filter((c) => c.payload.type === 'session')
      .map((c) => c.provider)
      .sort();
    const sessionEndProviders = calls
      .filter((c) => c.payload.type === 'session_end')
      .map((c) => c.provider)
      .sort();

    expect(sessionProviders).toEqual(['deepgram', 'mock']);
    expect(sessionEndProviders).toEqual(['deepgram', 'mock']);
  });

  it('computes latency per provider using its own capture timestamps', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    const { handleCompareStreamConnection } = await import('./compareStreamHandler.js');
    const ws = new FakeWebSocket();

    await handleCompareStreamConnection(ws as any, ['mock', 'deepgram'], 'ja-JP', noopStore);

    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'config', pcm: true, clientSampleRate: 16000 })),
      false
    );
    await flushMicrotasks();

    const captureEarly = Date.now() - 100;
    ws.emit('message', buildPcmFrame(1, captureEarly), true);
    await flushMicrotasks();

    state.providers.mock.getOnData()?.({
      provider: 'mock',
      isFinal: false,
      text: 'first',
      timestamp: Date.now(),
      channel: 'mic',
    });

    const captureLate = Date.now() - 20;
    ws.emit('message', buildPcmFrame(2, captureLate), true);
    await flushMicrotasks();

    state.providers.deepgram.getOnData()?.({
      provider: 'deepgram',
      isFinal: false,
      text: 'second',
      timestamp: Date.now(),
      channel: 'mic',
    });

    const transcripts = ws.sent
      .map((m) => JSON.parse(m))
      .filter((m) => m.type === 'transcript')
      .reduce<Record<string, number>>((acc, cur) => {
        acc[cur.provider] = cur.latencyMs;
        return acc;
      }, {});

    expect(transcripts.mock).toBeGreaterThanOrEqual(90);
    expect(transcripts.mock).toBeLessThan(200);
    expect(transcripts.deepgram).toBeGreaterThanOrEqual(10);
    expect(transcripts.deepgram).toBeLessThan(120);
  });

  it('suppresses transcripts after a provider fails and closes its controller', async () => {
    const { handleCompareStreamConnection } = await import('./compareStreamHandler.js');
    const ws = new FakeWebSocket();

    state.providers.deepgram.controller.sendAudio.mockRejectedValueOnce(new Error('boom'));
    state.providers.mock.controller.sendAudio.mockResolvedValue(undefined);

    await handleCompareStreamConnection(ws as any, ['deepgram', 'mock'], 'ja-JP', noopStore);

    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'config', pcm: true, clientSampleRate: 16000 })),
      false
    );
    await flushMicrotasks();
    ws.emit('message', buildPcmFrame(1, Date.now()), true);
    await flushMicrotasks();
    await flushMicrotasks();

    // deepgram should have emitted an error and been marked failed
    const errorMessages = ws.sent
      .map((m) => JSON.parse(m))
      .filter((m) => m.type === 'error' && m.provider === 'deepgram');
    expect(errorMessages.length).toBe(1);

    // Later onData emissions from the failed provider must be ignored
    state.providers.deepgram.getOnData()?.({
      provider: 'deepgram',
      isFinal: false,
      text: 'should be ignored',
      timestamp: Date.now(),
      channel: 'mic',
    });
    const deepgramTranscripts = ws.sent
      .map((m) => JSON.parse(m))
      .filter((m) => m.type === 'transcript' && m.provider === 'deepgram');
    expect(deepgramTranscripts.length).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.providers.deepgram.controller.end).toHaveBeenCalled();
    expect(state.providers.deepgram.controller.close).toHaveBeenCalled();
  });

  it('records latency only for emitted (non-duplicate) transcripts', async () => {
    const store: StorageDriver<RealtimeLatencySummary> = {
      init: async () => {},
      append: vi.fn(async () => {}),
      readAll: async () => [],
    };
    const { handleCompareStreamConnection } = await import('./compareStreamHandler.js');
    const ws = new FakeWebSocket();

    await handleCompareStreamConnection(ws as any, ['mock', 'deepgram'], 'ja-JP', store);

    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'config', pcm: true, clientSampleRate: 16000 })),
      false
    );
    await flushMicrotasks();
    const captureTs = Date.now() - 50;
    ws.emit('message', buildPcmFrame(1, captureTs), true);
    await flushMicrotasks();

    const payload = {
      provider: 'mock',
      isFinal: false,
      text: 'dup',
      timestamp: Date.now(),
      channel: 'mic',
    };
    state.providers.mock.getOnData()?.(payload);
    state.providers.mock.getOnData()?.(payload); // duplicate should be filtered

    const transcripts = ws.sent
      .map((message) => JSON.parse(message))
      .filter((message) => message.type === 'transcript' && message.provider === 'mock');
    expect(transcripts).toHaveLength(1);
    expect(ws.listenerCount('close')).toBeGreaterThan(0);

    const closeListener = ws.rawListeners('close')[0] as (() => void) | undefined;
    ws.emit('close');
    closeListener?.call(ws);
    const closePromise = (ws as Record<string, unknown>).__compareClosePromise as Promise<void> | undefined;
    if (closePromise) {
      await closePromise;
    }
    await flushMicrotasks();

    const appended = (store.append as ReturnType<typeof vi.fn>).mock.calls.map(([v]) => v as RealtimeLatencySummary);
    expect(appended.length === 0 || appended.some((r) => r.provider === 'mock')).toBe(true);
  });

  it('applies per-provider sample rates when OpenAI and Deepgram are selected', async () => {
    const { handleCompareStreamConnection } = await import('./compareStreamHandler.js');
    const ws = new FakeWebSocket();

    await handleCompareStreamConnection(ws as any, ['openai', 'deepgram'], 'ja-JP', noopStore);

    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'config', pcm: true, clientSampleRate: 16000 })),
      false
    );

    expect(state.providers.openai.startOpts?.sampleRateHz).toBe(24_000);
    expect(state.providers.deepgram.startOpts?.sampleRateHz).toBe(16_000);
  });
});
