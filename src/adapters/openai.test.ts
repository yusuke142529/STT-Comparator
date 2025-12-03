import { describe, expect, it, beforeEach, vi } from 'vitest';
import { OpenAIAdapter } from './openai.js';

// --- mocks ---
const wsState: { instances: any[] } = { instances: [] };

vi.mock('ws', () => {
  const { EventEmitter } = require('node:events');
  class FakeWebSocket extends EventEmitter {
    url: string;
    sent: Array<string | Buffer> = [];
    readyState = 0;
    constructor(url: string) {
      super();
      this.url = url;
      wsState.instances.push(this);
      queueMicrotask(() => this.emit('open'));
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
  }
  return { WebSocket: FakeWebSocket };
});

describe('OpenAIAdapter streaming', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.OPENAI_STREAMING_MODEL = 'gpt-4o-transcribe';
    wsState.instances.length = 0;
  });

  it('sends transcription_session.update and base64 audio, emits transcripts', async () => {
    const adapter = new OpenAIAdapter();
    const session = await adapter.startStreaming({
      language: 'en',
      sampleRateHz: 16000,
      encoding: 'linear16',
    });

    const ws = wsState.instances[0];
    expect(ws).toBeDefined();

    // wait for open and transcription_session.update
    await new Promise((r) => setTimeout(r, 10));
    const firstSend = ws.sent[0] as string;
    const parsed = JSON.parse(firstSend);
    expect(parsed.type).toBe('transcription_session.update');
    expect(parsed.session.input_audio_format).toBe('pcm16');
    expect(parsed.session.input_audio_sample_rate).toBe(24000);
    expect(parsed.session.input_audio_transcription.language).toBe('en');

    const transcripts: string[] = [];
    session.onData((t) => transcripts.push(`${t.isFinal ? 'F' : 'I'}:${t.text}`));

    const pcm = new Int16Array([1000, -1000]); // 2 samples
    await session.controller.sendAudio(Buffer.from(pcm.buffer));

    const audioSend = ws.sent.find((m) => typeof m === 'string' && m.includes('input_audio_buffer.append')) as string;
    expect(audioSend).toBeDefined();
    const audioPayload = JSON.parse(audioSend);
    expect(typeof audioPayload.audio).toBe('string');
    expect(audioPayload.audio.length).toBeGreaterThan(0);

    // emit interim and final messages
    ws.emit(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.delta',
        delta: { transcript: 'hello' },
      })
    );
    ws.emit(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        delta: { transcript: 'hello world' },
        words: [{ text: 'hello', start: 0, end: 0.5 }],
      })
    );

    await new Promise((r) => setTimeout(r, 5));
    expect(transcripts).toEqual(['I:hello', 'F:hello world']);
  });

  it('normalizes BCP-47 language to ISO code', async () => {
    const adapter = new OpenAIAdapter();
    await adapter.startStreaming({
      language: 'ja-JP',
      sampleRateHz: 16000,
      encoding: 'linear16',
    });

    const ws = wsState.instances.at(-1);
    await new Promise((r) => setTimeout(r, 10));
    const firstSend = ws.sent[0] as string;
    const parsed = JSON.parse(firstSend);
    expect(parsed.session.input_audio_transcription.language).toBe('ja');
  });

  it('commits remaining buffered audio on end even when shorter than min buffer', async () => {
    const adapter = new OpenAIAdapter();
    const session = await adapter.startStreaming({
      language: 'en',
      sampleRateHz: 16000,
      encoding: 'linear16',
    });

    const ws = wsState.instances.at(-1);
    // wait for open and session update send
    await new Promise((r) => setTimeout(r, 10));

    // Send a tiny chunk (<100ms after upsample) so normal commit would skip
    const tinyPcm = new Int16Array([1, -1, 2, -2]);
    await session.controller.sendAudio(Buffer.from(tinyPcm.buffer));

    await session.controller.end();

    const hasCommit = ws.sent.some(
      (m) => typeof m === 'string' && JSON.parse(m).type === 'input_audio_buffer.commit'
    );
    expect(hasCommit).toBe(true);
  });
});

describe('OpenAIAdapter batch', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.OPENAI_BATCH_MODEL = 'gpt-4o-transcribe';
  });

  it('wraps PCM into WAV and parses words', async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      const form = init?.body as FormData;
      expect(form).toBeDefined();
      const file = form.get('file') as Blob;
      expect(file).toBeInstanceOf(Blob);
      const buf = Buffer.from(await file.arrayBuffer());
      expect(buf.slice(0, 4).toString()).toBe('RIFF');
      const sampleRate = buf.readUInt32LE(24);
      expect(sampleRate).toBe(16000);
      return new Response(
        JSON.stringify({
          text: 'ok',
          words: [{ text: 'ok', start: 0, end: 0.5 }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    // @ts-expect-error override global fetch for test
    global.fetch = fetchMock;

    const adapter = new OpenAIAdapter();
    const pcm = new Int16Array([1, 2, 3, 4]);
    const result = await adapter.transcribeFileFromPCM(
      ReadableFromBuffer(Buffer.from(pcm.buffer)),
      { language: 'en', sampleRateHz: 16000, encoding: 'linear16' }
    );

    expect(fetchMock).toHaveBeenCalled();
    expect(result.text).toBe('ok');
    expect(result.words?.[0]?.text).toBe('ok');
  });

  it('normalizes BCP-47 language for batch transcription', async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      const form = init?.body as FormData;
      expect(form.get('language')).toBe('ja');
      return new Response(JSON.stringify({ text: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    // @ts-expect-error override global fetch for test
    global.fetch = fetchMock;

    const adapter = new OpenAIAdapter();
    const pcm = new Int16Array([1, 2]);
    await adapter.transcribeFileFromPCM(ReadableFromBuffer(Buffer.from(pcm.buffer)), {
      language: 'ja-JP',
      sampleRateHz: 16000,
      encoding: 'linear16',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

function ReadableFromBuffer(buf: Buffer): NodeJS.ReadableStream {
  const { Readable } = require('node:stream');
  return Readable.from(buf);
}
