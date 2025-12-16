import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const envSnapshot = {
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
  ELEVENLABS_TTS_VOICE_ID: process.env.ELEVENLABS_TTS_VOICE_ID,
  ELEVENLABS_TTS_OUTPUT_FORMAT: process.env.ELEVENLABS_TTS_OUTPUT_FORMAT,
};

vi.mock('../utils/ffmpeg.js', () => ({
  createPcmResampler: vi.fn(() => ({
    input: vi.fn(async () => {}),
    onChunk: vi.fn(() => {}),
    end: vi.fn(() => {}),
    onError: vi.fn(() => {}),
    onClose: vi.fn(() => {}),
    outputSampleRate: 16000,
  })),
  spawnPcmTranscoder: vi.fn(() => ({
    input: vi.fn(async () => {}),
    stream: Readable.from([Buffer.alloc(3200)]),
    end: vi.fn(() => {}),
    onError: vi.fn(() => {}),
    onClose: vi.fn((cb: (code: number | null) => void) => cb(0)),
  })),
}));

afterEach(() => {
  process.env.ELEVENLABS_API_KEY = envSnapshot.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_TTS_VOICE_ID = envSnapshot.ELEVENLABS_TTS_VOICE_ID;
  process.env.ELEVENLABS_TTS_OUTPUT_FORMAT = envSnapshot.ELEVENLABS_TTS_OUTPUT_FORMAT;
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('streamTtsPcm', () => {
  it('reads ELEVENLABS_TTS_VOICE_ID at call time (not import time)', async () => {
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_TTS_VOICE_ID;
    vi.resetModules();

    const { streamTtsPcm } = await import('./elevenlabsTts.js');

    process.env.ELEVENLABS_API_KEY = 'test-key';
    process.env.ELEVENLABS_TTS_VOICE_ID = 'voice-123';

    const fetchMock = vi.fn(async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      });
      return { ok: true, body } as any;
    });
    vi.stubGlobal('fetch', fetchMock as any);

    const gen = streamTtsPcm('hello', { sampleRate: 16000 });
    const first = await gen.next();
    expect(first.done).toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0] ?? '')).toContain('/v1/text-to-speech/voice-123/stream');

    await gen.return?.(undefined);
  });

  it('uses ffmpeg transcoder when output format is non-PCM', async () => {
    process.env.ELEVENLABS_API_KEY = 'test-key';
    process.env.ELEVENLABS_TTS_VOICE_ID = 'voice-123';
    process.env.ELEVENLABS_TTS_OUTPUT_FORMAT = 'mp3_44100_128';
    vi.resetModules();

    const { streamTtsPcm } = await import('./elevenlabsTts.js');
    const { spawnPcmTranscoder } = await import('../utils/ffmpeg.js');

    const fetchMock = vi.fn(async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      });
      return { ok: true, body } as any;
    });
    vi.stubGlobal('fetch', fetchMock as any);

    const gen = streamTtsPcm('hello', { sampleRate: 16000 });
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(spawnPcmTranscoder).toHaveBeenCalledTimes(1);

    await gen.return?.(undefined);
  });
});
