import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('./providerStatus.js', () => ({
  computeProviderAvailability: vi.fn(),
}));

import { ProviderAvailabilityCache } from './providerAvailabilityCache.js';
import { computeProviderAvailability } from './providerStatus.js';
import type { AppConfig } from '../types.js';
import type { ProviderAvailability } from './providerStatus.js';

const mockCompute = computeProviderAvailability as ReturnType<typeof vi.fn>;

const baseConfig: AppConfig = {
  audio: { targetSampleRate: 16000, targetChannels: 1, chunkMs: 250 },
  normalization: {},
  storage: { driver: 'jsonl', path: './runs', retentionDays: 30, maxRows: 100000 },
  providers: ['mock'],
  jobs: {},
  ws: {},
};

const availabilityA: ProviderAvailability[] = [
  { id: 'mock', available: true, implemented: true, supportsStreaming: true, supportsBatch: true },
];
const availabilityB: ProviderAvailability[] = [
  { id: 'mock', available: false, implemented: true, supportsStreaming: true, supportsBatch: true, reason: 'fallback' },
];

describe('ProviderAvailabilityCache', () => {
  beforeEach(() => {
    mockCompute.mockReset();
  });

  it('caches results within the refresh window', async () => {
    mockCompute.mockResolvedValue(availabilityA);
    const cache = new ProviderAvailabilityCache(baseConfig, 1000);
    await cache.get();
    await cache.get();
    expect(mockCompute).toHaveBeenCalledTimes(1);
  });

  it('forces a refresh when requested', async () => {
    mockCompute.mockResolvedValueOnce(availabilityA);
    const cache = new ProviderAvailabilityCache(baseConfig, 1000);
    await cache.get();
    mockCompute.mockResolvedValueOnce(availabilityB);
    await cache.get(true);
    expect(mockCompute).toHaveBeenCalledTimes(2);
    const latest = await cache.get();
    expect(latest[0].available).toBe(false);
  });

  it('recomputes after the TTL expires', async () => {
    mockCompute.mockResolvedValueOnce(availabilityA);
    const cache = new ProviderAvailabilityCache(baseConfig, 10);
    await cache.get();
    await new Promise((resolve) => setTimeout(resolve, 30));
    mockCompute.mockResolvedValueOnce(availabilityB);
    await cache.get();
    expect(mockCompute).toHaveBeenCalledTimes(2);
  });

  it('clears cache when the config is replaced', async () => {
    mockCompute.mockResolvedValueOnce(availabilityA);
    const cache = new ProviderAvailabilityCache(baseConfig, 1000);
    await cache.get();
    const nextConfig: AppConfig = { ...baseConfig, providers: ['mock', 'deepgram'] };
    mockCompute.mockResolvedValueOnce(availabilityB);
    cache.updateConfig(nextConfig);
    await cache.get();
    expect(mockCompute).toHaveBeenCalledTimes(2);
  });
});
