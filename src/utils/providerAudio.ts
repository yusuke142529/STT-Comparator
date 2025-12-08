import type { AppConfig, ProviderId } from '../types.js';

/**
 * Returns the preferred input sample rate for a provider.
 * OpenAI realtime performs best at 24 kHz mono PCM; others default to config.audio.targetSampleRate.
 */
export function getProviderSampleRate(provider: ProviderId, config: AppConfig): number {
  return provider === 'openai' ? 24_000 : config.audio.targetSampleRate;
}

export function isPerProviderTranscodeEnabled(): boolean {
  const flag = process.env.PER_PROVIDER_TRANSCODE;
  if (flag === undefined || flag === null) return true;
  return flag.toLowerCase() !== 'false' && flag !== '0';
}

export function requiresHighQualityTranscode(provider: ProviderId): boolean {
  return provider === 'openai';
}
