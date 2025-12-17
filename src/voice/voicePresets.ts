import type { AppConfig, VoiceAgentMode } from '../types.js';
import type { VoiceProviders } from './voiceProviders.js';
import {
  SUPPORTED_VOICE_STT_PROVIDERS,
  SUPPORTED_VOICE_TTS_PROVIDERS,
  getVoiceMissingEnv,
} from './voiceProviders.js';

export type VoicePreset = {
  id: string;
  label: string;
  mode: VoiceAgentMode;
  providers: VoiceProviders;
};

export type VoicePresetAvailability = VoicePreset & {
  available: boolean;
  missingEnv: string[];
  issues: string[];
};

export type VoicePresetCatalog = {
  presets: VoicePresetAvailability[];
  defaultPresetId: string | null;
};

const BUILTIN_PRESETS: VoicePreset[] = [
  {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    mode: 'pipeline',
    providers: { stt: 'elevenlabs', tts: 'elevenlabs', llm: 'openai' },
  },
  {
    id: 'openai_realtime',
    label: 'OpenAI Realtime API',
    mode: 'openai_realtime',
    providers: { stt: 'openai', tts: 'openai', llm: 'openai' },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    mode: 'pipeline',
    providers: { stt: 'openai', tts: 'openai', llm: 'openai' },
  },
  {
    id: 'deepgram',
    label: 'Deepgram (STT) + OpenAI (TTS)',
    mode: 'pipeline',
    providers: { stt: 'deepgram', tts: 'openai', llm: 'openai' },
  },
];

function normalizeOptionalEnv(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function toSafeId(value: string): string {
  return value.trim();
}

function listPresetsFromConfig(config: AppConfig): VoicePreset[] | null {
  const presets = config.voice?.presets;
  if (!presets || presets.length === 0) return null;

  const result: VoicePreset[] = [];
  for (const preset of presets) {
    const id = toSafeId(preset.id);
    if (!id) continue;

    const stt = preset.sttProvider;
    const tts = preset.ttsProvider;
    const mode = (preset.mode ?? 'pipeline') as VoiceAgentMode;

    result.push({
      id,
      label: preset.label?.trim() || id,
      mode,
      providers: { stt, tts, llm: 'openai' },
    });
  }

  return result.length > 0 ? result : null;
}

function buildAvailability(preset: VoicePreset): VoicePresetAvailability {
  const missingEnv = getVoiceMissingEnv(preset.providers, preset.mode);
  const issues: string[] = [];
  if (!SUPPORTED_VOICE_STT_PROVIDERS.has(preset.providers.stt)) {
    issues.push(`unsupported STT provider: ${preset.providers.stt}`);
  }
  if (!SUPPORTED_VOICE_TTS_PROVIDERS.has(preset.providers.tts)) {
    issues.push(`unsupported TTS provider: ${preset.providers.tts}`);
  }
  if (preset.mode === 'openai_realtime') {
    if (preset.providers.stt !== 'openai') issues.push('openai_realtime requires sttProvider=openai');
    if (preset.providers.tts !== 'openai') issues.push('openai_realtime requires ttsProvider=openai');
  }
  const available = missingEnv.length === 0 && issues.length === 0;
  return {
    ...preset,
    available,
    missingEnv,
    issues,
  };
}

function pickDefaultPresetId(config: AppConfig, presets: VoicePresetAvailability[]): string | null {
  const cfg = config.voice?.defaultPresetId?.trim();
  if (cfg && presets.some((p) => p.id === cfg)) {
    return cfg;
  }

  const envPreset = normalizeOptionalEnv(process.env.VOICE_PRESET_ID);
  if (envPreset && presets.some((p) => p.id === envPreset)) {
    return envPreset;
  }

  const sttEnv = normalizeOptionalEnv(process.env.VOICE_STT_PROVIDER);
  const ttsEnv = normalizeOptionalEnv(process.env.VOICE_TTS_PROVIDER);
  if (sttEnv && ttsEnv) {
    const match = presets.find((p) => p.providers.stt === sttEnv && p.providers.tts === ttsEnv);
    if (match) return match.id;
  }

  const firstAvailable = presets.find((p) => p.available);
  if (firstAvailable) return firstAvailable.id;

  return presets[0]?.id ?? null;
}

export function getVoicePresetCatalog(config: AppConfig): VoicePresetCatalog {
  const presets = listPresetsFromConfig(config) ?? BUILTIN_PRESETS;
  const availability = presets.map(buildAvailability);
  return {
    presets: availability,
    defaultPresetId: pickDefaultPresetId(config, availability),
  };
}

export function resolveVoicePreset(config: AppConfig, presetId?: string | null): VoicePresetAvailability {
  const catalog = getVoicePresetCatalog(config);
  if (catalog.presets.length === 0) {
    throw new Error('no voice presets configured');
  }

  const requested = presetId?.trim();
  const resolved =
    (requested ? catalog.presets.find((p) => p.id === requested) : null) ??
    (catalog.defaultPresetId ? catalog.presets.find((p) => p.id === catalog.defaultPresetId) : null) ??
    catalog.presets[0];

  if (!resolved) {
    throw new Error('no voice presets configured');
  }

  return resolved;
}
