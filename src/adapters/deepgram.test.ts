import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';

const wsInstances: any[] = [];

vi.mock('ws', () => {
  const { EventEmitter } = require('node:events');
  class FakeWebSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 0;
    url: string;
    opts: unknown;
    send = vi.fn();
    close = vi.fn(() => this.emit('close'));

    constructor(url: string, opts: unknown) {
      super();
      this.url = url;
      this.opts = opts;
      wsInstances.push(this);
    }
  }
  return { WebSocket: FakeWebSocket };
});

vi.mock('@ffmpeg-installer/ffmpeg', () => ({ path: '/bin/ffmpeg' }));

describe('DeepgramAdapter streaming', () => {
  beforeEach(() => {
    process.env.DEEPGRAM_API_KEY = 'dummy';
    wsInstances.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('送信は WebSocket OPEN 待ちで行われる', async () => {
    const { DeepgramAdapter } = await import('./deepgram.js');
    const adapter = new DeepgramAdapter();
    const session = await adapter.startStreaming({
      language: 'ja-JP',
      sampleRateHz: 16000,
      encoding: 'linear16',
    });

    const ws = wsInstances[0];
    const sendPromise = session.controller.sendAudio(new ArrayBuffer(2));

    expect(ws.send).not.toHaveBeenCalled();
    ws.emit('open');
    await sendPromise;
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it('context phrases が URL に含まれる', async () => {
    const { DeepgramAdapter } = await import('./deepgram.js');
    const adapter = new DeepgramAdapter();
    await adapter.startStreaming({
      language: 'ja-JP',
      sampleRateHz: 16000,
      encoding: 'linear16',
      contextPhrases: ['alpha', 'beta'],
    });
    const ws = wsInstances[0];
    const url = new URL(ws.url);
    expect(url.searchParams.get('context')).toBe('alpha,beta');
  });

  it('enableVad=false で endpointing が無効化される', async () => {
    const { DeepgramAdapter } = await import('./deepgram.js');
    const adapter = new DeepgramAdapter();
    await adapter.startStreaming({
      language: 'ja-JP',
      sampleRateHz: 16000,
      encoding: 'linear16',
      enableVad: false,
    });
    const ws = wsInstances[0];
    const url = new URL(ws.url);
    expect(url.searchParams.get('endpointing')).toBe('false');
    expect(url.searchParams.has('vad_events')).toBe(false);
  });

  it('enableVad=true で endpointing と vad_events が付与される', async () => {
    const { DeepgramAdapter } = await import('./deepgram.js');
    const adapter = new DeepgramAdapter();
    await adapter.startStreaming({
      language: 'ja-JP',
      sampleRateHz: 16000,
      encoding: 'linear16',
      enableVad: true,
    });
    const ws = wsInstances[0];
    const url = new URL(ws.url);
    expect(url.searchParams.get('endpointing')).toBe('400');
    expect(url.searchParams.get('vad_events')).toBe('true');
  });
});

describe('DeepgramAdapter batch', () => {
  beforeEach(() => {
    process.env.DEEPGRAM_API_KEY = 'dummy';
    wsInstances.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('context phrases が Deepgram HTTP リクエストに含まれる', async () => {
    const { DeepgramAdapter } = await import('./deepgram.js');
    const adapter = new DeepgramAdapter();
    const stream = new Readable({
      read() {
        this.push(Buffer.from('test'));
        this.push(null);
      },
    });
    const fakeResponse = {
      ok: true,
      status: 200,
      json: vi.fn(async () => ({
        results: [
          {
            channels: [
              {
                alternatives: [{ transcript: 'ok', words: [], duration: 1 }],
              },
            ],
          },
        ],
        metadata: { duration: 1, processing_ms: 5 },
      })),
      text: vi.fn(async () => ''),
    } as unknown as Response;
    const globalWithFetch = globalThis as typeof globalThis & { fetch: typeof fetch };
    const originalFetch = globalWithFetch.fetch;
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse);
    globalWithFetch.fetch = fetchMock as unknown as typeof fetch;

    try {
    await adapter.transcribeFileFromPCM(stream, {
      language: 'ja-JP',
      sampleRateHz: 16000,
      encoding: 'linear16',
      contextPhrases: ['ctx1', 'ctx2'],
      enableVad: false,
    });
    } finally {
      globalWithFetch.fetch = originalFetch;
    }

    const requestUrl = fetchMock.mock.calls[0]?.[0];
    expect(requestUrl).toBeDefined();
    const parsed = new URL(requestUrl as string);
    expect(parsed.searchParams.get('context')).toBe('ctx1,ctx2');
    expect(parsed.searchParams.get('endpointing')).toBe('false');
  });

  it('enableVad=true でバッチにも endpointing/vad_events が付与される', async () => {
    const { DeepgramAdapter } = await import('./deepgram.js');
    const adapter = new DeepgramAdapter();
    const stream = new Readable({
      read() {
        this.push(Buffer.from('test'));
        this.push(null);
      },
    });
    const fakeResponse = {
      ok: true,
      status: 200,
      json: vi.fn(async () => ({
        results: [
          {
            channels: [
              {
                alternatives: [{ transcript: 'ok', words: [], duration: 1 }],
              },
            ],
          },
        ],
      })),
      text: vi.fn(async () => ''),
    } as unknown as Response;
    const globalWithFetch = globalThis as typeof globalThis & { fetch: typeof fetch };
    const originalFetch = globalWithFetch.fetch;
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse);
    globalWithFetch.fetch = fetchMock as unknown as typeof fetch;

    try {
      await adapter.transcribeFileFromPCM(stream, {
        language: 'ja-JP',
        sampleRateHz: 16000,
        encoding: 'linear16',
        enableVad: true,
      });
    } finally {
      globalWithFetch.fetch = originalFetch;
    }

    const requestUrl = fetchMock.mock.calls[0]?.[0];
    expect(requestUrl).toBeDefined();
    const parsed = new URL(requestUrl as string);
    expect(parsed.searchParams.get('endpointing')).toBe('400');
    expect(parsed.searchParams.get('vad_events')).toBe('true');
  });

  it('集計レスポンスでも transcripts/utterances をすべて拾える', async () => {
    const { DeepgramAdapter } = await import('./deepgram.js');
    const adapter = new DeepgramAdapter();
    const stream = new Readable({
      read() {
        this.push(Buffer.from('test'));
        this.push(null);
      },
    });
    const fakeResponse = {
      ok: true,
      status: 200,
      json: vi.fn(async () => ({
        results: {
          alternatives: [
            { transcript: 'alpha', words: [{ start: 0, end: 0.1, word: 'alpha' }] },
          ],
          utterances: [{ transcript: 'utter' }],
        },
        utterances: [{ transcript: 'global' }],
        metadata: { duration: 1, processing_ms: 10 },
      })),
      text: vi.fn(async () => ''),
    } as unknown as Response;
    const globalWithFetch = globalThis as typeof globalThis & { fetch: typeof fetch };
    const originalFetch = globalWithFetch.fetch;
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse) as typeof fetch;
    globalWithFetch.fetch = fetchMock;

    try {
      const result = await adapter.transcribeFileFromPCM(stream, {
        language: 'ja-JP',
        sampleRateHz: 16000,
        encoding: 'linear16',
      });
      expect(result.text).toBe('alpha utter global');
      expect(result.words?.[0]?.text).toBe('alpha');
    } finally {
      globalWithFetch.fetch = originalFetch;
    }
  });
});
