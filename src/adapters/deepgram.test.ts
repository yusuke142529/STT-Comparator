import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

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
});
