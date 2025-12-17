import { afterEach, describe, expect, it, vi } from 'vitest';

const wsState: { instances: any[] } = { instances: [] };

vi.mock('ws', () => {
  const { EventEmitter } = require('node:events');
  class FakeWebSocket extends EventEmitter {
    url: string;
    sent: Array<string | Buffer> = [];
    readyState = 0;
    bufferedAmount = 0;
    static OPEN = 1;

    constructor(url: string) {
      super();
      this.url = url;
      wsState.instances.push(this);
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN;
        this.emit('open');
      });
    }

    send(data: string | Buffer) {
      this.sent.push(data);
    }

    close() {
      this.emit('close');
    }

    terminate() {
      this.emit('close');
    }

    ping() {
      // no-op
    }
  }

  return { WebSocket: FakeWebSocket };
});

const envSnapshot = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_REALTIME_MODEL: process.env.OPENAI_REALTIME_MODEL,
  OPENAI_REALTIME_TRANSCRIBE_MODEL: process.env.OPENAI_REALTIME_TRANSCRIBE_MODEL,
  OPENAI_REALTIME_VOICE: process.env.OPENAI_REALTIME_VOICE,
};

afterEach(() => {
  process.env.OPENAI_API_KEY = envSnapshot.OPENAI_API_KEY;
  process.env.OPENAI_REALTIME_MODEL = envSnapshot.OPENAI_REALTIME_MODEL;
  process.env.OPENAI_REALTIME_TRANSCRIBE_MODEL = envSnapshot.OPENAI_REALTIME_TRANSCRIBE_MODEL;
  process.env.OPENAI_REALTIME_VOICE = envSnapshot.OPENAI_REALTIME_VOICE;
  wsState.instances.length = 0;
  vi.resetModules();
});

describe('startOpenAiRealtimeVoiceSession', () => {
  it('uses OpenAI defaults when env is unset', async () => {
    process.env.OPENAI_API_KEY = 'test-openai';
    delete process.env.OPENAI_REALTIME_MODEL;
    delete process.env.OPENAI_REALTIME_TRANSCRIBE_MODEL;
    delete process.env.OPENAI_REALTIME_VOICE;

    const { startOpenAiRealtimeVoiceSession } = await import('./openaiRealtimeVoice.js');
    const session = startOpenAiRealtimeVoiceSession({ lang: 'ja-JP', systemPrompt: 'sys' }, {});

    const ws = wsState.instances.at(-1);
    expect(ws).toBeDefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(String(ws?.url ?? '')).toContain('model=gpt-realtime');

    const firstSend = ws.sent[0] as string;
    const parsed = JSON.parse(firstSend);
    expect(parsed.type).toBe('session.update');
    expect(parsed.session?.type).toBe('realtime');
    expect(parsed.session?.output_modalities).toEqual(['audio']);
    expect(parsed.session?.audio?.output?.voice).toBe('alloy');
    expect(parsed.session?.audio?.output?.format?.rate).toBe(24000);
    expect(parsed.session?.audio?.input?.transcription?.model).toBe('gpt-4o-mini-transcribe');

    ws.emit('message', JSON.stringify({ type: 'session.created' }));
    ws.emit('message', JSON.stringify({ type: 'session.updated' }));
    await session.ready;
    await session.close();
  });

  it('reads OPENAI_REALTIME_TRANSCRIBE_MODEL at call time', async () => {
    process.env.OPENAI_API_KEY = 'test-openai';

    const { startOpenAiRealtimeVoiceSession } = await import('./openaiRealtimeVoice.js');

    process.env.OPENAI_REALTIME_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';
    const s1 = startOpenAiRealtimeVoiceSession({ lang: 'en', systemPrompt: 'sys' }, {});
    const ws1 = wsState.instances.at(-1);
    await new Promise((r) => setTimeout(r, 0));
    const parsed1 = JSON.parse(ws1.sent[0] as string);
    expect(parsed1.session?.output_modalities).toEqual(['audio']);
    expect(parsed1.session?.audio?.input?.transcription?.model).toBe('gpt-4o-mini-transcribe');
    ws1.emit('message', JSON.stringify({ type: 'session.created' }));
    ws1.emit('message', JSON.stringify({ type: 'session.updated' }));
    await s1.ready;
    await s1.close();

    process.env.OPENAI_REALTIME_TRANSCRIBE_MODEL = 'gpt-4o-transcribe';
    const s2 = startOpenAiRealtimeVoiceSession({ lang: 'en', systemPrompt: 'sys' }, {});
    const ws2 = wsState.instances.at(-1);
    await new Promise((r) => setTimeout(r, 0));
    const parsed2 = JSON.parse(ws2.sent[0] as string);
    expect(parsed2.session?.output_modalities).toEqual(['audio']);
    expect(parsed2.session?.audio?.input?.transcription?.model).toBe('gpt-4o-transcribe');
    ws2.emit('message', JSON.stringify({ type: 'session.created' }));
    ws2.emit('message', JSON.stringify({ type: 'session.updated' }));
    await s2.ready;
    await s2.close();
  });
});
