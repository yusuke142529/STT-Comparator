import { describe, expect, it } from 'vitest';
import { getProviderSampleRate } from './providerAudio.js';

const baseConfig = {
  audio: { targetSampleRate: 16000, targetChannels: 1, chunkMs: 250 },
} as const;

describe('getProviderSampleRate', () => {
  it('returns 24k for openai', () => {
    expect(getProviderSampleRate('openai', baseConfig as any)).toBe(24_000);
  });

  it('returns config audio sample rate for non-openai', () => {
    expect(getProviderSampleRate('deepgram', baseConfig as any)).toBe(16_000);
  });
});
