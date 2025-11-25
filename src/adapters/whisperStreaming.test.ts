import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';

const wsInstances: any[] = [];
let wsShouldError = false;

vi.mock('ws', () => {
  const { EventEmitter } = require('node:events');
  class FakeWebSocket extends EventEmitter {
    url: string;
    send = vi.fn();
    terminate = vi.fn(() => this.emit('close'));
    close = vi.fn(() => this.emit('close'));
    constructor(url: string) {
      super();
      this.url = url;
      wsInstances.push(this);
      queueMicrotask(() => {
        if (wsShouldError) {
          this.emit('error', new Error('ws failure'));
        } else {
          this.emit('open');
        }
      });
    }
  }
  return { WebSocket: FakeWebSocket };
});

describe('WhisperStreamingAdapter streaming', () => {
  beforeEach(() => {
    wsInstances.length = 0;
    wsShouldError = false;
    process.env.WHISPER_MODEL = 'tiny';
  });

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('waits for open, sends init, and forwards transcript messages', async () => {
    const { WhisperStreamingAdapter } = await import('./whisperStreaming.js');
    const adapter = new WhisperStreamingAdapter();
    const session = await adapter.startStreaming({
      language: 'ja-JP',
      sampleRateHz: 16000,
      encoding: 'linear16',
    });
    const ws = wsInstances[0];

    const onData = vi.fn();
    session.onData(onData);

    const sendPromise = session.controller.sendAudio(new ArrayBuffer(4));
    expect(ws.send).toHaveBeenCalledTimes(1); // init message

    await sendPromise;
    expect(ws.send).toHaveBeenCalledTimes(2); // init + audio
    expect(ws.send.mock.calls[0][0]).toContain('"language":"ja-JP"');
    expect(ws.send.mock.calls[0][0]).toContain('"model":"tiny"');

    ws.emit('message', JSON.stringify({ text: 'hello', is_final: true }));
    expect(onData).toHaveBeenCalledTimes(1);
    expect(onData.mock.calls[0][0]).toMatchObject({ text: 'hello', isFinal: true });
  });
});

describe('WhisperStreamingAdapter batch', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    wsInstances.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('streams PCM to HTTP endpoint and parses response', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          text: 'hello world',
          duration: 1.5,
          words: [{ start: 0, end: 0.5, word: 'hello' }],
          processing_ms: 1234,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const { WhisperStreamingAdapter } = await import('./whisperStreaming.js');
    const adapter = new WhisperStreamingAdapter();
    const result = await adapter.transcribeFileFromPCM(Readable.from([Buffer.alloc(4)]), {
      language: 'en',
      sampleRateHz: 16000,
      encoding: 'linear16',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = (fetchMock.mock.calls[0][1]?.headers ?? {}) as Record<string, string>;
    expect(headers['Content-Type']).toContain('audio/l16');
    expect(result.text).toBe('hello world');
    expect(result.words?.[0].text).toBe('hello');
    expect(result.durationSec).toBe(1.5);
    expect(result.vendorProcessingMs).toBe(1234);
  });

  it('does not abort while waiting for HTTP response after upload ends', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() =>
      new Promise<Response>((resolve) => {
        setTimeout(
          () =>
            resolve(
              new Response(
                JSON.stringify({ text: 'slow', duration: 2.0 }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
              )
            ),
          60_000
        );
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const { WhisperStreamingAdapter } = await import('./whisperStreaming.js');
    const adapter = new WhisperStreamingAdapter();
    const promise = adapter.transcribeFileFromPCM(Readable.from([Buffer.alloc(4)]), {
      language: 'en',
      sampleRateHz: 16000,
      encoding: 'linear16',
    });

    await vi.advanceTimersByTimeAsync(60_000);
    const res = await promise;
    expect(res.text).toBe('slow');
  });
});
