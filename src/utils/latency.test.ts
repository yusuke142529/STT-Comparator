import { describe, expect, it, vi, afterEach } from 'vitest';
import type { RealtimeLatencySummary, StorageDriver } from '../types.js';
import { persistLatency } from './latency.js';

const noopStore: StorageDriver<RealtimeLatencySummary> = {
  init: async () => {},
  append: async () => {},
  readAll: async () => [],
};

describe('persistLatency', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aggregates and writes latency stats when values exist', async () => {
    const append = vi.fn();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-03-01T00:00:05.000Z'));

    await persistLatency(
      [100, 200, 300],
      { sessionId: 's1', provider: 'mock', lang: 'ja-JP', startedAt: '2024-03-01T00:00:00.000Z' },
      { ...noopStore, append }
    );

    expect(append).toHaveBeenCalledTimes(1);
    const payload = append.mock.calls[0][0];
    expect(payload.sessionId).toBe('s1');
    expect(payload.avg).toBeCloseTo(200);
    expect(payload.p50).toBeCloseTo(200);
    expect(payload.p95).toBeCloseTo(290);
    expect(payload.min).toBe(100);
    expect(payload.max).toBe(300);
    expect(payload.endedAt).toBe('2024-03-01T00:00:05.000Z');
  });

  it('skips persistence for empty sessions', async () => {
    const append = vi.fn();
    await persistLatency([], { sessionId: 's1', provider: 'mock', lang: 'ja-JP', startedAt: '2024-03-01T00:00:00.000Z' }, {
      ...noopStore,
      append,
    });

    expect(append).not.toHaveBeenCalled();
  });
});
