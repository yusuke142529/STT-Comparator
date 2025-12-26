import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { LocalWhisperAdapter } from './localWhisper.js';

describe('LocalWhisperAdapter', () => {
  it('throws for streaming (not supported)', async () => {
    const adapter = new LocalWhisperAdapter();
    await expect(adapter.startStreaming()).rejects.toThrow(/does not support streaming/i);
  });

  it('uses runWhisper result for batch PCM', async () => {
    const adapter = new LocalWhisperAdapter();
    const wavPath = '/tmp/fake.wav';
    const expected = {
      text: 'hello world',
      durationSec: 1.23,
      vendorProcessingMs: 456,
      words: [{ startSec: 0, endSec: 0.2, text: 'hello', confidence: 0.9 }],
    };

    vi.spyOn(adapter as any, 'toWavFile').mockResolvedValue(wavPath);
    const runSpy = vi.spyOn(adapter as any, 'runWhisper').mockResolvedValue(expected);

    const pcm = Readable.from(Buffer.from([0, 1, 2]));
    const res = await adapter.transcribeFileFromPCM(pcm, {
      language: 'ja-JP',
      sampleRateHz: 16000,
      encoding: 'linear16',
    });

    expect(runSpy).toHaveBeenCalledWith(expect.any(String), wavPath, 'ja');
    expect(res.provider).toBe('local_whisper');
    expect(res.text).toBe(expected.text);
    expect(res.durationSec).toBeCloseTo(expected.durationSec!);
    expect(res.vendorProcessingMs).toBe(expected.vendorProcessingMs);
    expect(res.words?.[0]?.text).toBe('hello');
  });
});
