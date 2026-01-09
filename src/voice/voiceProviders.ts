import type { ProviderId, VoiceAgentMode } from '../types.js';
import { getOpenAiResponsesUrl } from './openaiResponses.js';

export type VoiceProviders = {
  stt: ProviderId;
  tts: ProviderId;
  llm: 'openai';
};

const DEFAULT_STT_PROVIDER: ProviderId = 'elevenlabs';
const DEFAULT_TTS_PROVIDER: ProviderId = 'elevenlabs';

export const SUPPORTED_VOICE_STT_PROVIDERS: ReadonlySet<ProviderId> = new Set([
  'deepgram',
  'elevenlabs',
  'openai',
  'whisper_streaming',
  'mock',
]);

export const SUPPORTED_VOICE_TTS_PROVIDERS: ReadonlySet<ProviderId> = new Set(['elevenlabs', 'openai']);

function normalizeEnvValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function getVoiceProviders(): VoiceProviders {
  const sttEnv = normalizeEnvValue(process.env.VOICE_STT_PROVIDER);
  const ttsEnv = normalizeEnvValue(process.env.VOICE_TTS_PROVIDER);

  const stt = (sttEnv ?? DEFAULT_STT_PROVIDER) as ProviderId;
  const tts = (ttsEnv ?? DEFAULT_TTS_PROVIDER) as ProviderId;

  if (!SUPPORTED_VOICE_STT_PROVIDERS.has(stt)) {
    throw new Error(
      `VOICE_STT_PROVIDER must be one of: ${Array.from(SUPPORTED_VOICE_STT_PROVIDERS).join(', ')}`
    );
  }
  if (!SUPPORTED_VOICE_TTS_PROVIDERS.has(tts)) {
    throw new Error(
      `VOICE_TTS_PROVIDER must be one of: ${Array.from(SUPPORTED_VOICE_TTS_PROVIDERS).join(', ')}`
    );
  }

  return { stt, tts, llm: 'openai' };
}

export function getVoiceMissingEnv(providers: VoiceProviders, mode?: VoiceAgentMode): string[] {
  const missing: string[] = [];

  // --- STT ---
  if (providers.stt === 'deepgram') {
    if (!process.env.DEEPGRAM_API_KEY) missing.push('DEEPGRAM_API_KEY');
  }
  if (providers.stt === 'elevenlabs') {
    if (!process.env.ELEVENLABS_API_KEY) missing.push('ELEVENLABS_API_KEY');
  }
  if (providers.stt === 'openai') {
    if (!process.env.OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  }

  // --- LLM (OpenAI) ---
  if (!process.env.OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  if (mode !== 'openai_realtime') {
    try {
      getOpenAiResponsesUrl();
    } catch {
      missing.push('OPENAI_RESPONSES_URL');
    }
  }

  // --- TTS ---
  if (providers.tts === 'elevenlabs') {
    if (!process.env.ELEVENLABS_API_KEY) missing.push('ELEVENLABS_API_KEY');
    if (!process.env.ELEVENLABS_TTS_VOICE_ID) missing.push('ELEVENLABS_TTS_VOICE_ID');
  }
  if (providers.tts === 'openai') {
    if (!process.env.OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  }

  return Array.from(new Set(missing));
}
