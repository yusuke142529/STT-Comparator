import type { AppConfig, ProviderId } from '../types.js';

// Conservative defaults sourced from public provider limits; can be overridden via config.providerLimits.batchMaxBytes.
const DEFAULT_BATCH_MAX_BYTES: Partial<Record<ProviderId, number>> = {
  openai: 25 * 1024 * 1024, // ~25MB per /v1/audio/transcriptions
  deepgram: 50 * 1024 * 1024,
  elevenlabs: 25 * 1024 * 1024,
  whisper_streaming: 50 * 1024 * 1024,
  local_whisper: 120 * 1024 * 1024, // bounded by upload limit
  mock: 120 * 1024 * 1024,
};

export function getBatchMaxBytes(provider: ProviderId, config: AppConfig): number | undefined {
  return config.providerLimits?.batchMaxBytes?.[provider] ?? DEFAULT_BATCH_MAX_BYTES[provider];
}
