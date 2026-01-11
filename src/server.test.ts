import type { Request, Response } from 'express';
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

const makeJsonResponder = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    json(this: { statusCode: number; body: unknown }, payload: unknown) {
      this.body = payload;
      return this;
    },
    status(this: { statusCode: number }, code: number) {
      this.statusCode = code;
      return this;
    },
  };
  return res as Response & { body: unknown; statusCode: number };
};

const callLatencyHandler = async (handler: ReturnType<typeof createRealtimeLatencyHandler>, query: Record<string, unknown>) => {
  const req = { query } as Request;
  const res = makeJsonResponder();
  const next = vi.fn();
  await handler(req, res, next);
  return { res, next };
};

describe('GET /api/realtime/latency', () => {
  it('uses readRecent when available', async () => {
    const driver: StorageDriver<RealtimeLatencySummary> = {
      readRecent: vi.fn().mockResolvedValue([sampleSummary({ sessionId: 'recent' })]),
      init: vi.fn(),
      append: vi.fn(),
      readAll: vi.fn(),
    };

    const handler = createRealtimeLatencyHandler(driver);
    const { res } = await callLatencyHandler(handler, { limit: '5' });

    expect(driver.readRecent).toHaveBeenCalledWith(5);
    expect(res.statusCode).toBe(200);
    expect((res.body as RealtimeLatencySummary[])[0].sessionId).toBe('recent');
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

    const handler = createRealtimeLatencyHandler(driver);
    const { res } = await callLatencyHandler(handler, { limit: '1' });

    expect(driver.readAll).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect((res.body as RealtimeLatencySummary[])).toHaveLength(1);
    expect((res.body as RealtimeLatencySummary[])[0].sessionId).toBe('new');
  });

  it('defaults and clamps limit when invalid', async () => {
    const driver: StorageDriver<RealtimeLatencySummary> = {
      readRecent: vi.fn().mockResolvedValue([sampleSummary({ sessionId: 'limited' })]),
      init: vi.fn(),
      append: vi.fn(),
      readAll: vi.fn(),
    };
    const handler = createRealtimeLatencyHandler(driver);

    await callLatencyHandler(handler, { limit: 'not-a-number' });

    expect(driver.readRecent).toHaveBeenCalledWith(20); // default

    await callLatencyHandler(handler, { limit: '500' });
    expect(driver.readRecent).toHaveBeenCalledWith(50); // clamped
  });
});
