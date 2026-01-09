import { afterEach, describe, expect, it, vi } from 'vitest';

const envSnapshot = {
  VOICE_STT_PROVIDER: process.env.VOICE_STT_PROVIDER,
  VOICE_TTS_PROVIDER: process.env.VOICE_TTS_PROVIDER,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_RESPONSES_URL: process.env.OPENAI_RESPONSES_URL,
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
  ELEVENLABS_TTS_VOICE_ID: process.env.ELEVENLABS_TTS_VOICE_ID,
  DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
};

const restoreEnv = (key: keyof typeof envSnapshot) => {
  const value = envSnapshot[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
};

afterEach(() => {
  restoreEnv('VOICE_STT_PROVIDER');
  restoreEnv('VOICE_TTS_PROVIDER');
  restoreEnv('OPENAI_API_KEY');
  restoreEnv('OPENAI_RESPONSES_URL');
  restoreEnv('ELEVENLABS_API_KEY');
  restoreEnv('ELEVENLABS_TTS_VOICE_ID');
  restoreEnv('DEEPGRAM_API_KEY');
  vi.resetModules();
});

describe('voiceProviders', () => {
  it('defaults to elevenlabs for stt/tts', async () => {
    delete process.env.VOICE_STT_PROVIDER;
    delete process.env.VOICE_TTS_PROVIDER;
    vi.resetModules();

    const { getVoiceProviders } = await import('./voiceProviders.js');
    expect(getVoiceProviders()).toEqual({ stt: 'elevenlabs', tts: 'elevenlabs', llm: 'openai' });
  });

  it('rejects unsupported providers', async () => {
    delete process.env.VOICE_STT_PROVIDER;
    process.env.VOICE_TTS_PROVIDER = 'bogus';
    vi.resetModules();

    const { getVoiceProviders } = await import('./voiceProviders.js');
    expect(() => getVoiceProviders()).toThrow(/VOICE_TTS_PROVIDER/i);
  });

  it('reports missing env for all-OpenAI mode without requiring ElevenLabs', async () => {
    process.env.VOICE_STT_PROVIDER = 'openai';
    process.env.VOICE_TTS_PROVIDER = 'openai';
    delete process.env.OPENAI_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_TTS_VOICE_ID;
    vi.resetModules();

    const { getVoiceMissingEnv, getVoiceProviders } = await import('./voiceProviders.js');
    const providers = getVoiceProviders();
    const missing = getVoiceMissingEnv(providers);
    expect(missing).toContain('OPENAI_API_KEY');
    expect(missing).not.toContain('ELEVENLABS_API_KEY');
    expect(missing).not.toContain('ELEVENLABS_TTS_VOICE_ID');
  });

  it('does not require OPENAI_RESPONSES_URL for openai_realtime mode', async () => {
    process.env.VOICE_STT_PROVIDER = 'openai';
    process.env.VOICE_TTS_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'test-openai';
    process.env.OPENAI_RESPONSES_URL = 'https://example.com/v1/responses';
    vi.resetModules();

    const { getVoiceMissingEnv, getVoiceProviders } = await import('./voiceProviders.js');
    const providers = getVoiceProviders();
    expect(getVoiceMissingEnv(providers, 'pipeline')).toContain('OPENAI_RESPONSES_URL');
    expect(getVoiceMissingEnv(providers, 'openai_realtime')).not.toContain('OPENAI_RESPONSES_URL');
  });
});
