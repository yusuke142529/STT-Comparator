import { describe, expect, it, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { RealtimeLatencySummary, RealtimeTranscriptLogEntry, StorageDriver } from '../types.js';
import type { RealtimeTranscriptLogWriter } from '../storage/realtimeTranscriptStore.js';

const noopStore: StorageDriver<RealtimeLatencySummary> = {
  init: async () => {},
  append: async () => {},
  readAll: async () => [],
};

describe('handleStreamConnection', () => {
  class FakeWebSocket extends EventEmitter {
    sent: string[] = [];
    closed = false;

    send(data: string) {
      this.sent.push(data);
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      this.emit('close');
    }
  }

  const state = vi.hoisted(() => {
    const { PassThrough: NodePassThrough } = require('node:stream');
    const passthrough = new NodePassThrough();
    let onDataHandler: ((t: any) => void) | null = null;

    const controller = {
      sendAudio: vi.fn(async () => {
        setTimeout(() => {
          onDataHandler?.({ provider: 'mock', isFinal: false, text: 'hi', timestamp: Date.now(), channel: 'mic' });
        }, 20);
      }),
      end: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };

    return {
      passthrough,
      controller,
      setOnData: (cb: (t: any) => void) => {
        onDataHandler = cb;
      },
      getOnData: () => onDataHandler,
      reset() {
        onDataHandler = null;
        passthrough.removeAllListeners();
      },
    };
  });

  vi.mock('../config.js', () => ({
    loadConfig: vi.fn().mockResolvedValue({
      audio: { targetSampleRate: 16000, targetChannels: 1, chunkMs: 250 },
      normalization: {},
      storage: { driver: 'jsonl', path: './runs' },
      providers: ['mock'],
    }),
  }));

  vi.mock('../adapters/index.js', () => ({
    getAdapter: vi.fn(() => ({
      id: 'mock',
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

  vi.mock('../utils/ffmpeg.js', () => ({
    spawnPcmTranscoder: vi.fn(() => ({
      input: async (chunk: Buffer) => state.passthrough.push(chunk),
      stream: state.passthrough,
      end: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn(),
    })),
  }));

  afterEach(() => {
    state.reset();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('計測レイテンシが直近送信基準になる', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    const { handleStreamConnection } = await import('./streamHandler.js');
    const ws = new FakeWebSocket();

    await handleStreamConnection(ws as any, 'mock', 'ja-JP', noopStore);

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'config' })), false);
    ws.emit('message', Buffer.from([1, 2, 3]), true);
    for (let i = 0; i < 5 && !state.getOnData(); i += 1) {
      await Promise.resolve();
    }

    vi.advanceTimersByTime(25);

    const messages = ws.sent.map((m) => JSON.parse(m));
    const transcript = messages.find((m) => m.type === 'transcript');
    expect(state.controller.sendAudio).toHaveBeenCalled();
    expect(state.getOnData()).toBeDefined();
    expect(transcript).toBeDefined();
    expect(typeof transcript?.latencyMs).toBe('number');
    expect(transcript?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('logs session and transcript events when realtime logging is enabled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    const logStore: RealtimeTranscriptLogWriter = {
      append: vi.fn(async () => {}),
    };
    const { handleStreamConnection } = await import('./streamHandler.js');
    const ws = new FakeWebSocket();

    await handleStreamConnection(ws as any, 'mock', 'ja-JP', noopStore, logStore);

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'config' })), false);
    ws.emit('message', Buffer.from([1, 2, 3]), true);
    for (let i = 0; i < 5 && !state.getOnData(); i += 1) {
      await Promise.resolve();
    }

    vi.advanceTimersByTime(25);
    await Promise.resolve();

    const mockedAppend = logStore.append as ReturnType<typeof vi.fn>;
    const recordedEntries = mockedAppend.mock.calls.map(([entry]) => entry as RealtimeTranscriptLogEntry);
    const sessionEntry = recordedEntries.find((entry) => entry.payload.type === 'session');
    const transcriptEntry = recordedEntries.find((entry) => entry.payload.type === 'transcript');

    expect(sessionEntry).toBeDefined();
    expect(transcriptEntry).toBeDefined();
    expect(transcriptEntry?.sessionId).toBe(sessionEntry?.sessionId);
    expect(typeof transcriptEntry?.payload.latencyMs).toBe('number');
  });

  it('avoids sending transcripts when text/isFinal/channel matches the last payload', async () => {
    const { handleStreamConnection } = await import('./streamHandler.js');
    const ws = new FakeWebSocket();

    await handleStreamConnection(ws as any, 'mock', 'ja-JP', noopStore);

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'config' })), false);
    for (let i = 0; i < 5 && !state.getOnData(); i += 1) {
      await Promise.resolve();
    }

    const handler = state.getOnData();
    expect(handler).toBeDefined();
    const baseTime = Date.now();
    handler?.({
      provider: 'mock',
      isFinal: false,
      text: 'hello',
      timestamp: baseTime,
      channel: 'mic',
    });
    handler?.({
      provider: 'mock',
      isFinal: false,
      text: 'hello',
      timestamp: baseTime + 1,
      channel: 'mic',
    });
    handler?.({
      provider: 'mock',
      isFinal: false,
      text: 'hello world',
      timestamp: baseTime + 2,
      channel: 'mic',
    });
    await Promise.resolve();

    const transcripts = ws.sent
      .map((message) => JSON.parse(message))
      .filter((message) => message.type === 'transcript');
    expect(transcripts).toHaveLength(2);
    expect(transcripts.map((message) => message.text)).toEqual(['hello', 'hello world']);
  });

  it('不正な config で error を返しソケットを閉じる', async () => {
    const { handleStreamConnection } = await import('./streamHandler.js');
    const ws = new FakeWebSocket();

    await handleStreamConnection(ws as any, 'mock', 'ja-JP', noopStore);

    ws.emit('message', Buffer.from('not-json'), false);

    expect(ws.sent.some((m) => JSON.parse(m).type === 'error')).toBe(true);
    expect(ws.closed).toBe(true);
  });

  it('辞書が上限超過ならエラーで閉じる', async () => {
    const { handleStreamConnection } = await import('./streamHandler.js');
    const ws = new FakeWebSocket();

    await handleStreamConnection(ws as any, 'mock', 'ja-JP', noopStore);

    const oversized = Array.from({ length: 101 }, (_, i) => `w${i}`);
    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'config', dictionaryPhrases: oversized })),
      false
    );

    expect(ws.sent.some((m) => JSON.parse(m).type === 'error')).toBe(true);
    expect(ws.closed).toBe(true);
  });
});
