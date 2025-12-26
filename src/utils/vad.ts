import type { VadConfig } from '../types.js';

export type ResolvedVadConfig = {
  threshold: number;
  silenceDurationMs: number;
  prefixPaddingMs: number;
};

const DEFAULT_VAD: ResolvedVadConfig = {
  threshold: 0.5,
  silenceDurationMs: 500,
  prefixPaddingMs: 300,
};

const clampNumber = (value: number | undefined, min: number, max: number, fallback: number): number => {
  const safe = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, safe));
};

export function resolveVadConfig(vad?: VadConfig): ResolvedVadConfig {
  const threshold = clampNumber(vad?.threshold, 0, 1, DEFAULT_VAD.threshold);
  const silenceDurationMs = clampNumber(vad?.silenceDurationMs, 50, 5000, DEFAULT_VAD.silenceDurationMs);
  const prefixPaddingMs = clampNumber(vad?.prefixPaddingMs, 0, 2000, DEFAULT_VAD.prefixPaddingMs);
  return {
    threshold,
    silenceDurationMs: Math.round(silenceDurationMs),
    prefixPaddingMs: Math.round(prefixPaddingMs),
  };
}
