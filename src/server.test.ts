import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createRealtimeLatencyHandler } from './server.js';
import type { RealtimeLatencySummary, StorageDriver } from './types.js';

const sampleSummary = (overrides: Partial<RealtimeLatencySummary> = {}): RealtimeLatencySummary => ({
  sessionId: 's1',
  provider: 'mock',
  lang: 'ja-JP',
  count: 2,
  avg: 100,
  p50: 90,
  p95: 110,
  min: 80,
  max: 130,
  startedAt: '2024-01-01T00:00:00.000Z',
  endedAt: '2024-01-01T00:00:10.000Z',
  ...overrides,
});

describe('GET /api/realtime/latency', () => {
  it('uses readRecent when available', async () => {
    const driver: StorageDriver<RealtimeLatencySummary> = {
      readRecent: vi.fn().mockResolvedValue([sampleSummary({ sessionId: 'recent' })]),
      init: vi.fn(),
      append: vi.fn(),
      readAll: vi.fn(),
    };

    const app = express();
    app.get('/api/realtime/latency', createRealtimeLatencyHandler(driver));

    const res = await request(app).get('/api/realtime/latency?limit=5');

    expect(driver.readRecent).toHaveBeenCalledWith(5);
    expect(res.status).toBe(200);
    expect(res.body[0].sessionId).toBe('recent');
  });

  it('falls back to readAll when readRecent is missing', async () => {
    const driver: StorageDriver<RealtimeLatencySummary> = {
      init: vi.fn(),
      append: vi.fn(),
      readAll: vi.fn().mockResolvedValue([
        sampleSummary({ sessionId: 'old' }),
        sampleSummary({ sessionId: 'new', startedAt: '2024-02-01T00:00:00.000Z' }),
      ]),
    } as StorageDriver<RealtimeLatencySummary>;

    const app = express();
    app.get('/api/realtime/latency', createRealtimeLatencyHandler(driver));

    const res = await request(app).get('/api/realtime/latency?limit=1');

    expect(driver.readAll).toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].sessionId).toBe('new');
  });

  it('defaults and clamps limit when invalid', async () => {
    const driver: StorageDriver<RealtimeLatencySummary> = {
      readRecent: vi.fn().mockResolvedValue([sampleSummary({ sessionId: 'limited' })]),
      init: vi.fn(),
      append: vi.fn(),
      readAll: vi.fn(),
    };
    const app = express();
    app.get('/api/realtime/latency', createRealtimeLatencyHandler(driver));

    await request(app).get('/api/realtime/latency?limit=not-a-number');

    expect(driver.readRecent).toHaveBeenCalledWith(20); // default

    await request(app).get('/api/realtime/latency?limit=500');
    expect(driver.readRecent).toHaveBeenCalledWith(50); // clamped
  });
});
