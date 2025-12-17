import { afterEach, describe, expect, it, vi } from 'vitest';

const envSnapshot = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_TTS_MODEL: process.env.OPENAI_TTS_MODEL,
  OPENAI_TTS_VOICE: process.env.OPENAI_TTS_VOICE,
};

vi.mock('../utils/ffmpeg.js', () => ({
  createPcmResampler: vi.fn(() => {
    let onChunkCb: ((chunk: Buffer, meta: any) => void) | null = null;
    let onCloseCb: ((code: number | null) => void) | null = null;
    return {
      input: vi.fn(async () => {
        onChunkCb?.(Buffer.alloc(3200), { captureTs: Date.now(), durationMs: 0, seq: 0 });
      }),
      onChunk: vi.fn((cb: (chunk: Buffer, meta: any) => void) => {
        onChunkCb = cb;
      }),
      end: vi.fn(() => {
        onCloseCb?.(0);
      }),
      onError: vi.fn(() => {}),
      onClose: vi.fn((cb: (code: number | null) => void) => {
        onCloseCb = cb;
      }),
      outputSampleRate: 16000,
    };
  }),
}));

afterEach(() => {
  process.env.OPENAI_API_KEY = envSnapshot.OPENAI_API_KEY;
  process.env.OPENAI_TTS_MODEL = envSnapshot.OPENAI_TTS_MODEL;
  process.env.OPENAI_TTS_VOICE = envSnapshot.OPENAI_TTS_VOICE;
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('streamOpenAiTtsPcm', () => {
  it('reads OPENAI_API_KEY at call time (not import time)', async () => {
    delete process.env.OPENAI_API_KEY;
    vi.resetModules();
    const { streamOpenAiTtsPcm } = await import('./openaiTts.js');

    process.env.OPENAI_API_KEY = 'test-key';
    delete process.env.OPENAI_TTS_MODEL;
    delete process.env.OPENAI_TTS_VOICE;

    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      expect(body.model).toBe('gpt-4o-mini-tts');
      expect(body.voice).toBe('alloy');
      expect(body.input).toBe('hello');
      expect(body.response_format).toBe('pcm');

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3, 4]));
          controller.close();
        },
      });
      return { ok: true, body: stream } as any;
    });
    vi.stubGlobal('fetch', fetchMock as any);

    const gen = streamOpenAiTtsPcm('hello', { sampleRate: 24_000 });
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0] ?? '')).toContain('/v1/audio/speech');

    await gen.return?.(undefined);
  });

  it('uses ffmpeg resampler when output sample rate differs', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.resetModules();
    const { streamOpenAiTtsPcm } = await import('./openaiTts.js');
    const { createPcmResampler } = await import('../utils/ffmpeg.js');

    const fetchMock = vi.fn(async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3, 4]));
          controller.close();
        },
      });
      return { ok: true, body: stream } as any;
    });
    vi.stubGlobal('fetch', fetchMock as any);

    const gen = streamOpenAiTtsPcm('hello', { sampleRate: 16_000 });
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(createPcmResampler).toHaveBeenCalledTimes(1);

    await gen.return?.(undefined);
  });
});

