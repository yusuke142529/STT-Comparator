import { describe, expect, beforeEach, beforeAll, it, vi } from 'vitest';

vi.mock('./whisper.js', () => ({
  getWhisperRuntime: vi.fn(),
  resetWhisperRuntimeCache: vi.fn(),
}));

vi.mock('ws', () => {
  const { EventEmitter } = require('node:events');
  const state = {
    instances: [] as any[],
    outcome: 'open' as 'open' | 'error' | 'close',
    error: null as Error | null,
  };
  class FakeWebSocket extends EventEmitter {
    url: string;
    terminate = vi.fn(() => this.emit('close'));
    close = vi.fn(() => this.emit('close'));
    constructor(url: string) {
      super();
      this.url = url;
      state.instances.push(this);
      queueMicrotask(() => {
        if (state.outcome === 'open') this.emit('open');
        else if (state.outcome === 'error') this.emit('error', state.error ?? new Error('ws error'));
        else this.emit('close');
      });
    }
  }
  return {
    WebSocket: FakeWebSocket,
    __setOutcome: (outcome: 'open' | 'error' | 'close', error?: Error) => {
      state.outcome = outcome;
      state.error = error ?? null;
    },
    __instances: state.instances,
  };
});

import { computeProviderAvailability } from './providerStatus.js';
import { getWhisperRuntime, resetWhisperRuntimeCache } from './whisper.js';
import type { AppConfig } from '../types.js';

const mockGetWhisperRuntime = getWhisperRuntime as unknown as ReturnType<typeof vi.fn>;
const mockReset = resetWhisperRuntimeCache as unknown as ReturnType<typeof vi.fn>;

const baseConfig: AppConfig = {
  audio: { targetSampleRate: 16000, targetChannels: 1, chunkMs: 250 },
  normalization: {},
  storage: { driver: 'jsonl', path: './runs', retentionDays: 30, maxRows: 100000 },
  providers: ['local_whisper'],
  jobs: {},
  ws: {},
};

describe('computeProviderAvailability(local_whisper)', () => {
  beforeEach(() => {
    mockGetWhisperRuntime.mockReset();
    mockReset.mockReset();
  });

  it('returns unavailable when whisper runtime is missing', async () => {
    mockGetWhisperRuntime.mockReturnValue({ pythonPath: null, reason: 'missing' });

    const result = await computeProviderAvailability(baseConfig);
    const lw = result.find((p) => p.id === 'local_whisper');

    expect(mockReset).toHaveBeenCalled();
    expect(lw).toBeDefined();
    expect(lw?.available).toBe(false);
    expect(lw?.supportsBatch).toBe(true);
    expect(lw?.supportsStreaming).toBe(false);
    expect(lw?.reason).toContain('missing');
  });

  it('returns available with batch-only support when runtime exists', async () => {
    mockGetWhisperRuntime.mockReturnValue({ pythonPath: '/tmp/python' });

    const result = await computeProviderAvailability(baseConfig);
    const lw = result.find((p) => p.id === 'local_whisper');

    expect(lw?.available).toBe(true);
    expect(lw?.supportsBatch).toBe(true);
    expect(lw?.supportsStreaming).toBe(false);
  });
});

describe('computeProviderAvailability(whisper_streaming)', () => {
  let wsMockModule: any;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    wsMockModule = await import('ws');
  });

  beforeEach(() => {
    (wsMockModule.__setOutcome as any)('open');
    wsMockModule.__instances.length = 0;
    fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('marks available when WS opens', async () => {
    (wsMockModule.__setOutcome as any)('open');
    const config: AppConfig = { ...baseConfig, providers: ['whisper_streaming'] };
    const result = await computeProviderAvailability(config);
    expect(result[0].available).toBe(true);
    expect(wsMockModule.__instances.length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('marks unavailable with reason when WS errors', async () => {
    (wsMockModule.__setOutcome as any)('error', new Error('conn refused'));
    const config: AppConfig = { ...baseConfig, providers: ['whisper_streaming'] };
    const result = await computeProviderAvailability(config);
    expect(result[0].available).toBe(false);
    expect(result[0].reason).toContain('conn refused');
  });

  it('marks unavailable when HTTP health fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('fail', { status: 500 }));
    const config: AppConfig = { ...baseConfig, providers: ['whisper_streaming'] };
    const result = await computeProviderAvailability(config);
    expect(result[0].available).toBe(false);
    expect(result[0].reason).toContain('http');
  });

  it('marks available when HTTP returns a client error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not allowed', { status: 405, statusText: 'Method Not Allowed' }));
    const config: AppConfig = { ...baseConfig, providers: ['whisper_streaming'] };
    const result = await computeProviderAvailability(config);
    expect(result[0].available).toBe(true);
    expect(result[0].reason).toBeUndefined();
  });

  it('uses HTTP error when WS succeeds but HTTP rejects', async () => {
    fetchMock.mockRejectedValueOnce(new Error('http down'));
    const config: AppConfig = { ...baseConfig, providers: ['whisper_streaming'] };
    const result = await computeProviderAvailability(config);
    expect(result[0].available).toBe(false);
    expect(result[0].reason).toContain('http down');
  });
});
