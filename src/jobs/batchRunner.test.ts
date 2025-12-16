import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BatchJobFileResult, StorageDriver } from '../types.js';
import { JobHistory } from './jobHistory.js';

vi.mock('../config.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    audio: { targetSampleRate: 16000, targetChannels: 1, chunkMs: 250 },
    ingressNormalize: { enabled: true },
    normalization: {},
    storage: { driver: 'jsonl', path: './runs' },
    providers: ['mock'],
  }),
}));

describe('BatchRunner', () => {
  const memoryStore = (): StorageDriver<BatchJobFileResult> & { records: BatchJobFileResult[] } => {
    const records: BatchJobFileResult[] = [];
    return {
      records,
      init: async () => {},
      append: async (r: BatchJobFileResult) => {
        records.push(r);
      },
      readAll: async () => records,
    };
  };

  const setupRunner = async (store: ReturnType<typeof memoryStore>) => {
    const history = new JobHistory(store);
    await history.init();
    const { BatchRunner } = await import('./batchRunner.js');
    const runner = new BatchRunner(store, history);
    await runner.init();
    return { runner, store };
  };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const waitForJob = async (
    runner: { getStatus: (id: string) => any },
    jobId: string,
    timeoutMs = 500
  ) => {
    const start = Date.now();
    let lastStatus: any = null;
    while (Date.now() - start < timeoutMs) {
      const status = runner.getStatus(jobId);
      lastStatus = status;
      if (status && (status.done + status.failed >= status.total)) return status;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`job did not complete in time; last status: ${JSON.stringify(lastStatus)}`);
  };

  it('falls back to measured duration when adapter does not provide durationSec', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'batch-test-'));
    const filePath = path.join(tmp, 'a.wav');
    await writeFile(filePath, Buffer.from('a'));

    vi.doMock('../utils/audioIngress.js', () => ({
      ensureNormalizedAudio: vi.fn(async (p: string) => ({
        normalizedPath: p,
        durationSec: 2,
        bytes: 4,
        degraded: false,
        generated: false,
        signature: 'sig',
        release: async () => {},
      })),
      AudioValidationError: class extends Error {},
    }));

    vi.doMock('../utils/ffmpeg.js', () => {
      const stream = new PassThrough();
      stream.end(Buffer.from([0, 1, 2, 3]));
      return {
        convertToPcmReadable: vi.fn(async () => ({
          stream,
          durationPromise: Promise.resolve(2),
        })),
      };
    });

    vi.doMock('../adapters/index.js', () => ({
      getAdapter: vi.fn(() => ({
        id: 'mock',
        supportsStreaming: true,
        supportsBatch: true,
        startStreaming: vi.fn(),
        transcribeFileFromPCM: vi.fn(async () => ({ provider: 'mock', text: 'hi' })),
      })),
    }));

    const store = memoryStore();
    const { runner } = await setupRunner(store);
    const jobSpy = vi.spyOn(runner as any, 'processJob');
    const { jobId } = await runner.enqueue(['mock'], 'ja-JP', [{ path: filePath, originalname: 'a.wav', size: 1 }]);

    await waitForJob(runner as any, jobId);

    expect(jobSpy).toHaveBeenCalled();

    expect(store.records).toHaveLength(1);
    expect(store.records[0].durationSec).toBeCloseTo(2, 6);
  });

  it('ignores adapter durationSec=0 and uses measured duration', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'batch-test-'));
    const filePath = path.join(tmp, 'a0.wav');
    await writeFile(filePath, Buffer.from('a'));

    vi.doMock('../utils/audioIngress.js', () => ({
      ensureNormalizedAudio: vi.fn(async (p: string) => ({
        normalizedPath: p,
        durationSec: 2,
        bytes: 4,
        degraded: false,
        generated: false,
        signature: 'sig',
        release: async () => {},
      })),
      AudioValidationError: class extends Error {},
    }));

    vi.doMock('../utils/ffmpeg.js', () => {
      const stream = new PassThrough();
      stream.end(Buffer.from([0, 1, 2, 3]));
      return {
        convertToPcmReadable: vi.fn(async () => ({
          stream,
          durationPromise: Promise.resolve(2),
        })),
      };
    });

    vi.doMock('../adapters/index.js', () => ({
      getAdapter: vi.fn(() => ({
        id: 'mock',
        supportsStreaming: true,
        supportsBatch: true,
        startStreaming: vi.fn(),
        transcribeFileFromPCM: vi.fn(async () => ({ provider: 'mock', text: 'hi', durationSec: 0 })),
      })),
    }));

    const store = memoryStore();
    const { runner } = await setupRunner(store);
    const { jobId } = await runner.enqueue(['mock'], 'ja-JP', [
      { path: filePath, originalname: 'a0.wav', size: 1 },
    ]);

    await waitForJob(runner as any, jobId);

    expect(store.records).toHaveLength(1);
    expect(store.records[0].durationSec).toBeCloseTo(2, 6);
  });

  it('marks file as failed when manifest mapping is missing', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'batch-test-'));
    const filePath = path.join(tmp, 'b.wav');
    await writeFile(filePath, Buffer.from('b'));

    vi.doMock('../utils/audioIngress.js', () => ({
      ensureNormalizedAudio: vi.fn(async (p: string) => ({
        normalizedPath: p,
        durationSec: 1,
        bytes: 4,
        degraded: false,
        generated: false,
        signature: 'sig',
        release: async () => {},
      })),
      AudioValidationError: class extends Error {},
    }));

    vi.doMock('../utils/ffmpeg.js', () => {
      const stream = new PassThrough();
      stream.end();
      return {
        convertToPcmReadable: vi.fn(async () => ({
          stream,
          durationPromise: Promise.resolve(1),
        })),
      };
    });

    vi.doMock('../adapters/index.js', () => ({
      getAdapter: vi.fn(() => ({
        id: 'mock',
        supportsStreaming: true,
        supportsBatch: true,
        startStreaming: vi.fn(),
        transcribeFileFromPCM: vi.fn(async () => ({ provider: 'mock', text: 'hi', durationSec: 1 })),
      })),
    }));

    const store = memoryStore();
    const { runner } = await setupRunner(store);
    const { jobId } = await runner.enqueue(
      ['mock'],
      'ja-JP',
      [{ path: filePath, originalname: 'b.wav', size: 1 }],
      { version: 1, language: 'ja-JP', items: [{ audio: 'a.wav', ref: 'ref' }] }
    );

    const status = await waitForJob(runner as any, jobId);

    expect(store.records).toHaveLength(0);
    expect(status?.failed).toBe(1);
    expect(status?.errors?.[0]?.message).toContain('manifest');
  });

  it('keeps total count after files array is cleared', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'batch-test-'));
    const filePathA = path.join(tmp, 'a.wav');
    const filePathB = path.join(tmp, 'b.wav');
    await writeFile(filePathA, Buffer.from('a'));
    await writeFile(filePathB, Buffer.from('b'));

    vi.doMock('../utils/audioIngress.js', () => ({
      ensureNormalizedAudio: vi.fn(async (p: string) => ({
        normalizedPath: p,
        durationSec: 1,
        bytes: 4,
        degraded: false,
        generated: false,
        signature: 'sig',
        release: async () => {},
      })),
      AudioValidationError: class extends Error {},
    }));

    vi.doMock('../utils/ffmpeg.js', () => {
      const stream = new PassThrough();
      stream.end(Buffer.from('a'));
      return {
        convertToPcmReadable: vi.fn(async () => ({
          stream,
          durationPromise: Promise.resolve(1),
        })),
      };
    });

    vi.doMock('../adapters/index.js', () => ({
      getAdapter: vi.fn(() => ({
        id: 'mock',
        supportsStreaming: true,
        supportsBatch: true,
        startStreaming: vi.fn(),
        transcribeFileFromPCM: vi.fn(async () => ({ provider: 'mock', text: 'hi', durationSec: 1 })),
      })),
    }));

    const store = memoryStore();
    const { runner } = await setupRunner(store);
    const { jobId } = await runner.enqueue(['mock'], 'ja-JP', [
      { path: filePathA, originalname: 'a.wav', size: 1 },
      { path: filePathB, originalname: 'b.wav', size: 1 },
    ]);

    const status = await waitForJob(runner as any, jobId);
    expect(status?.total).toBe(2);
    expect((status?.done ?? 0) + (status?.failed ?? 0)).toBe(2);
  });

  it('processes all selected providers for each file', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'batch-test-'));
    const filePath = path.join(tmp, 'c.wav');
    await writeFile(filePath, Buffer.from('c'));

    vi.doMock('../utils/audioIngress.js', () => ({
      ensureNormalizedAudio: vi.fn(async (p: string) => ({
        normalizedPath: p,
        durationSec: 1,
        bytes: 4,
        degraded: false,
        generated: false,
        signature: 'sig',
        release: async () => {},
      })),
      AudioValidationError: class extends Error {},
    }));

    vi.doMock('../utils/ffmpeg.js', () => {
      const stream = new PassThrough();
      stream.end(Buffer.from('a'));
      return {
        convertToPcmReadable: vi.fn(async () => ({
          stream,
          durationPromise: Promise.resolve(1),
        })),
      };
    });

    const transcribe = vi.fn(async (_pcm: any, _opts: any) => ({ provider: 'mock', text: 'ok', durationSec: 1 }));
    vi.doMock('../adapters/index.js', () => ({
      getAdapter: vi.fn((id: string) => ({
        id,
        supportsStreaming: true,
        supportsBatch: true,
        startStreaming: vi.fn(),
        transcribeFileFromPCM: transcribe,
      })),
    }));

    const store = memoryStore();
    const { runner } = await setupRunner(store);
    const { jobId } = await runner.enqueue(['p1', 'p2'], 'ja-JP', [
      { path: filePath, originalname: 'c.wav', size: 1 },
    ]);

    const status = await waitForJob(runner as any, jobId);
    expect(status?.total).toBe(2);
    expect(status?.done).toBe(2);
    expect(store.records).toHaveLength(2);
    expect(new Set(store.records.map((r) => r.provider))).toEqual(new Set(['p1', 'p2']));
    expect(transcribe).toHaveBeenCalledTimes(2);
  });

  it('releases normalized audio when PCM conversion fails during prepare', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'batch-test-'));
    const filePath = path.join(tmp, 'd.wav');
    await writeFile(filePath, Buffer.from('d'));

    const release = vi.fn(async () => {});
    vi.doMock('../utils/audioIngress.js', () => ({
      ensureNormalizedAudio: vi.fn(async (p: string) => ({
        normalizedPath: p,
        durationSec: 1,
        bytes: 4,
        degraded: false,
        generated: false,
        signature: 'sig',
        release,
      })),
      AudioValidationError: class extends Error {},
    }));

    vi.doMock('../utils/ffmpeg.js', () => ({
      convertToPcmReadable: vi.fn(async () => {
        throw new Error('ffmpeg fail');
      }),
    }));

    vi.doMock('../adapters/index.js', () => ({
      getAdapter: vi.fn(() => ({
        id: 'mock',
        supportsStreaming: true,
        supportsBatch: true,
        startStreaming: vi.fn(),
        transcribeFileFromPCM: vi.fn(async () => ({ provider: 'mock', text: 'hi', durationSec: 1 })),
      })),
    }));

    const store = memoryStore();
    const { runner } = await setupRunner(store);
    const { jobId } = await runner.enqueue(['mock'], 'ja-JP', [{ path: filePath, originalname: 'd.wav', size: 1 }]);

    const status = await waitForJob(runner as any, jobId);
    expect(status?.failed).toBe(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(store.records).toHaveLength(0);
  });

  it('does not keep in-memory results when storage append fails', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'batch-test-'));
    const filePath = path.join(tmp, 'e.wav');
    await writeFile(filePath, Buffer.from('e'));

    vi.doMock('../utils/audioIngress.js', () => ({
      ensureNormalizedAudio: vi.fn(async (p: string) => ({
        normalizedPath: p,
        durationSec: 1,
        bytes: 4,
        degraded: false,
        generated: false,
        signature: 'sig',
        release: async () => {},
      })),
      AudioValidationError: class extends Error {},
    }));

    vi.doMock('../utils/ffmpeg.js', () => {
      const stream = new PassThrough();
      stream.end(Buffer.from([0, 1, 2, 3]));
      return {
        convertToPcmReadable: vi.fn(async () => ({
          stream,
          durationPromise: Promise.resolve(1),
        })),
      };
    });

    vi.doMock('../adapters/index.js', () => ({
      getAdapter: vi.fn(() => ({
        id: 'mock',
        supportsStreaming: true,
        supportsBatch: true,
        startStreaming: vi.fn(),
        transcribeFileFromPCM: vi.fn(async () => ({ provider: 'mock', text: 'hi', durationSec: 1 })),
      })),
    }));

    const records: BatchJobFileResult[] = [];
    const store: StorageDriver<BatchJobFileResult> & { records: BatchJobFileResult[] } = {
      records,
      init: async () => {},
      append: async () => {
        throw new Error('append failed');
      },
      readAll: async () => records,
    };
    const { runner } = await setupRunner(store);
    const { jobId } = await runner.enqueue(['mock'], 'ja-JP', [{ path: filePath, originalname: 'e.wav', size: 1 }]);

    const status = await waitForJob(runner as any, jobId);
    expect(status?.done).toBe(0);
    expect(status?.failed).toBe(1);
    expect(status?.errors?.[0]?.message).toContain('append failed');
    expect(store.records).toHaveLength(0);

    const results = await (runner as any).getResults(jobId);
    expect(results).toHaveLength(0);
  });
});
