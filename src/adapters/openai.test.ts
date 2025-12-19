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
    static OPEN = 1;
    constructor(url: string) {
      super();
      this.url = url;
      wsState.instances.push(this);
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN;
        this.emit('open');
        // GA interface waits for session.created/session.updated before sending audio.
        this.emit('message', JSON.stringify({ type: 'session.created' }));
        this.emit('message', JSON.stringify({ type: 'session.updated' }));
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
  }
  return { WebSocket: FakeWebSocket };
});

describe('OpenAIAdapter streaming', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.OPENAI_STREAMING_MODEL = 'gpt-4o-transcribe';
    wsState.instances.length = 0;
  });

  it('reads OPENAI_STREAMING_MODEL at call time (not import time)', async () => {
    process.env.OPENAI_STREAMING_MODEL = 'gpt-4o-mini-transcribe';

    const adapter = new OpenAIAdapter();
    await adapter.startStreaming({
      language: 'en',
      sampleRateHz: 24000,
      encoding: 'linear16',
    });

    const ws = wsState.instances.at(-1);
    await new Promise((r) => setTimeout(r, 10));
    expect(String(ws?.url ?? '')).toContain('intent=transcription');
    const firstSend = ws.sent[0] as string;
    const parsed = JSON.parse(firstSend);
    expect(parsed.type).toBe('session.update');
    expect(parsed.session?.type).toBe('transcription');
    expect(parsed.session?.audio?.input?.transcription?.model).toBe('gpt-4o-mini-transcribe');
  });

  it('defaults to gpt-4o-transcribe when OPENAI_STREAMING_MODEL is unset', async () => {
    delete process.env.OPENAI_STREAMING_MODEL;

    const adapter = new OpenAIAdapter();
    await adapter.startStreaming({
      language: 'en',
      sampleRateHz: 24000,
      encoding: 'linear16',
    });

    const ws = wsState.instances.at(-1);
    await new Promise((r) => setTimeout(r, 10));
    expect(String(ws?.url ?? '')).toContain('intent=transcription');
    const firstSend = ws.sent[0] as string;
    const parsed = JSON.parse(firstSend);
    expect(parsed.type).toBe('session.update');
    expect(parsed.session?.type).toBe('transcription');
    expect(parsed.session?.audio?.input?.transcription?.model).toBe('gpt-4o-transcribe');
  });

  it('builds prompt from context/dictionary and surfaces speakerId from events', async () => {
    const adapter = new OpenAIAdapter();
    const session = await adapter.startStreaming({
      language: 'en',
      sampleRateHz: 24000,
      encoding: 'linear16',
      contextPhrases: ['alpha', 'beta'],
      dictionaryPhrases: ['beta', 'gamma'],
    });

    const ws = wsState.instances[0];
    await new Promise((r) => setTimeout(r, 10));
    const firstSend = ws.sent[0] as string;
    const parsed = JSON.parse(firstSend);
    expect(parsed.session?.audio?.input?.transcription?.prompt).toBe('alpha, beta, gamma');

    const seen: Array<{ text: string; speakerId?: string }> = [];
    session.onData((t) => seen.push({ text: t.text, speakerId: t.speakerId }));

    ws.emit(
      'message',
      JSON.stringify({
        type: 'input_audio_buffer.committed',
        item_id: 'item-1',
        previous_item_id: 'root',
      })
    );

    ws.emit(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'item-1',
        delta: { transcript: 'hi', speaker: 'A' },
      })
    );
    ws.emit(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item-1',
        delta: { transcript: 'hi there', speaker: 'B' },
      })
    );

    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual([
      { text: 'hi', speakerId: 'A' },
      { text: 'hi there', speakerId: 'B' },
    ]);
  });

  it('sends session.update with transcription audio config and base64 audio, emits transcripts', async () => {
    const adapter = new OpenAIAdapter();
    const session = await adapter.startStreaming({
      language: 'en',
      sampleRateHz: 24000,
      encoding: 'linear16',
    });

    const ws = wsState.instances[0];
    expect(ws).toBeDefined();

    // wait for open and session.update
    await new Promise((r) => setTimeout(r, 10));
    const firstSend = ws.sent[0] as string;
    const parsed = JSON.parse(firstSend);
    expect(parsed.type).toBe('session.update');
    expect(parsed.session?.type).toBe('transcription');
    expect(parsed.session?.audio?.input?.format?.type).toBe('audio/pcm');
    expect(parsed.session?.audio?.input?.format?.rate).toBe(24000);
    expect(parsed.session?.audio?.input?.transcription?.language).toBe('en');

    const transcripts: string[] = [];
    session.onData((t) => transcripts.push(`${t.isFinal ? 'F' : 'I'}:${t.text}`));

    const pcm = new Int16Array([1000, -1000]); // 2 samples
    await session.controller.sendAudio(Buffer.from(pcm.buffer));

    ws.emit(
      'message',
      JSON.stringify({
        type: 'input_audio_buffer.committed',
        item_id: 'item-1',
        previous_item_id: 'root',
      })
    );

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
        item_id: 'item-1',
        delta: { transcript: 'hello' },
      })
    );
    ws.emit(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'item-1',
        delta: { transcript: ' world' },
      })
    );
    ws.emit(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item-1',
        delta: { transcript: 'hello world' },
        words: [{ text: 'hello', start: 0, end: 0.5 }],
      })
    );

    await new Promise((r) => setTimeout(r, 5));
    expect(transcripts).toEqual(['I:hello', 'I:hello world', 'F:hello world']);
  });

  it('normalizes BCP-47 language to ISO code', async () => {
    const adapter = new OpenAIAdapter();
    await adapter.startStreaming({
      language: 'ja-JP',
      sampleRateHz: 24000,
      encoding: 'linear16',
    });

    const ws = wsState.instances.at(-1);
    await new Promise((r) => setTimeout(r, 10));
    const firstSend = ws.sent[0] as string;
    const parsed = JSON.parse(firstSend);
    expect(parsed.type).toBe('session.update');
    expect(parsed.session?.audio?.input?.transcription?.language).toBe('ja');
  });

  it('commits remaining buffered audio on end even when shorter than min buffer', async () => {
    const adapter = new OpenAIAdapter();
    const session = await adapter.startStreaming({
      language: 'en',
      sampleRateHz: 24000,
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

  it('does not drop buffered audio when committed arrives after new audio', async () => {
    const adapter = new OpenAIAdapter();
    const session = await adapter.startStreaming({
      language: 'en',
      sampleRateHz: 24000,
      encoding: 'linear16',
    });

    const ws = wsState.instances.at(-1);
    await new Promise((r) => setTimeout(r, 10));

    const countCommits = () =>
      ws.sent.filter((m) => typeof m === 'string' && JSON.parse(m).type === 'input_audio_buffer.commit').length;

    await session.controller.sendAudio(Buffer.from(new Int16Array([1, -1]).buffer));
    await session.controller.end();
    expect(countCommits()).toBe(1);

    await session.controller.sendAudio(Buffer.from(new Int16Array([2, -2]).buffer));

    // Simulate a late commit ack for the previous turn arriving after the next audio append.
    ws.emit(
      'message',
      JSON.stringify({
        type: 'input_audio_buffer.committed',
        item_id: 'item-old',
        previous_item_id: 'root',
      })
    );

    await session.controller.end();
    expect(countCommits()).toBe(2);
  });

  it('emits completed transcripts in committed order even when completions arrive out of order', async () => {
    const adapter = new OpenAIAdapter();
    const session = await adapter.startStreaming({
      language: 'en',
      sampleRateHz: 24000,
      encoding: 'linear16',
    });

    const ws = wsState.instances.at(-1);
    expect(ws).toBeDefined();
    await new Promise((r) => setTimeout(r, 10));

    const finals: string[] = [];
    session.onData((t) => {
      if (t.isFinal) finals.push(t.text);
    });

    ws.emit(
      'message',
      JSON.stringify({
        type: 'input_audio_buffer.committed',
        item_id: 'item-1',
        previous_item_id: 'root',
      })
    );
    ws.emit(
      'message',
      JSON.stringify({
        type: 'input_audio_buffer.committed',
        item_id: 'item-2',
        previous_item_id: 'item-1',
      })
    );

    ws.emit(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item-2',
        transcript: 'second',
      })
    );
    ws.emit(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item-1',
        transcript: 'first',
      })
    );

    await new Promise((r) => setTimeout(r, 5));
    expect(finals).toEqual(['first', 'second']);
  });
});

describe('OpenAIAdapter batch', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.OPENAI_BATCH_MODEL = 'gpt-4o-transcribe';
  });

  it('reads OPENAI_BATCH_MODEL at call time (not import time)', async () => {
    process.env.OPENAI_BATCH_MODEL = 'gpt-4o-mini-transcribe';

    const fetchMock = vi.fn(async (_url, init) => {
      const form = init?.body as FormData;
      expect(form.get('model')).toBe('gpt-4o-mini-transcribe');
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
      language: 'en',
      sampleRateHz: 16000,
      encoding: 'linear16',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
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
