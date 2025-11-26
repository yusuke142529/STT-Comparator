import type { ProviderId, StreamingConfigMessage, TranscriptionOptions } from '../types.js';

export interface RealtimeReplayConfig {
  serverUrl: string;
  provider: ProviderId;
  ffmpegPath: string;
  enableInterim?: boolean;
  normalizePreset?: string;
  transcriptionOptions?: TranscriptionOptions;
  contextPhrases?: readonly string[];
}

export interface LatencyStats {
  count: number;
  meanMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

export function buildStreamingConfigMessage(
  config: Pick<RealtimeReplayConfig, 'enableInterim' | 'normalizePreset' | 'transcriptionOptions' | 'contextPhrases'>
): StreamingConfigMessage {
  const message: StreamingConfigMessage = { type: 'config' };
  if (config.enableInterim) {
    message.enableInterim = true;
  }
  if (config.contextPhrases && config.contextPhrases.length > 0) {
    message.contextPhrases = config.contextPhrases;
  }
  if (config.normalizePreset) {
    message.normalizePreset = config.normalizePreset;
  }
  if (config.transcriptionOptions) {
    message.options = config.transcriptionOptions;
  }
  return message;
}

export function computeLatencyStats(latencies: number[]): LatencyStats {
  if (latencies.length === 0) {
    return { count: 0, meanMs: null, p95Ms: null, maxMs: null };
  }
  const total = latencies.reduce((sum, value) => sum + value, 0);
  const sorted = [...latencies].sort((a, b) => a - b);
  const p95Index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1));
  return {
    count: latencies.length,
    meanMs: total / latencies.length,
    p95Ms: sorted[p95Index],
    maxMs: sorted[sorted.length - 1],
  };
}

export function formatLatencyStats(stats: LatencyStats): string {
  if (stats.count === 0) {
    return 'no latency metrics (count=0)';
  }
  return `count=${stats.count} mean=${stats.meanMs?.toFixed(1)}ms p95=${stats.p95Ms?.toFixed(1)}ms max=${stats.maxMs?.toFixed(1)}ms`;
}
