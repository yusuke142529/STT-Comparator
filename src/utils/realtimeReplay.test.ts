import { describe, expect, it } from 'vitest';
import { buildStreamingConfigMessage, computeLatencyStats } from './realtimeReplay.js';

describe('realtimeReplay utils', () => {
  it('builds a config message with optional fields', () => {
    const message = buildStreamingConfigMessage({
      enableInterim: true,
      normalizePreset: 'ja_cer',
      contextPhrases: ['テスト', '文脈'],
      transcriptionOptions: { enableVad: false, punctuationPolicy: 'full' },
    });

    expect(message).toEqual({
      type: 'config',
      enableInterim: true,
      normalizePreset: 'ja_cer',
      contextPhrases: ['テスト', '文脈'],
      options: { enableVad: false, punctuationPolicy: 'full' },
    });
  });

  it('calculates latency stats correctly', () => {
    const values = [100, 200, 400, 800, 1000];
    const stats = computeLatencyStats(values);
    expect(stats.count).toBe(values.length);
    expect(stats.meanMs).toBe(500);
    expect(stats.p95Ms).toBe(1000);
    expect(stats.maxMs).toBe(1000);
  });

  it('returns null stats when there is no data', () => {
    const stats = computeLatencyStats([]);
    expect(stats.count).toBe(0);
    expect(stats.meanMs).toBeNull();
    expect(stats.p95Ms).toBeNull();
    expect(stats.maxMs).toBeNull();
  });
});
