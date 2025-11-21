import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BatchJobFileResult, StorageDriver } from '../types.js';

vi.mock('../config.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    audio: { targetSampleRate: 16000, targetChannels: 1, chunkMs: 250 },
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

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to measured duration when adapter does not provide durationSec', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'batch-test-'));
    const filePath = path.join(tmp, 'a.wav');
    await writeFile(filePath, Buffer.from('a'));

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

    const { BatchRunner } = await import('./batchRunner.js');
    const store = memoryStore();
    const runner = new BatchRunner(store);
    await runner.init();
    await runner.enqueue('mock', 'ja-JP', [{ path: filePath, originalname: 'a.wav', size: 1 }]);

    await new Promise((r) => setTimeout(r, 20));

    expect(store.records).toHaveLength(1);
    expect(store.records[0].durationSec).toBeCloseTo(2, 6);
  });

  it('marks file as failed when manifest mapping is missing', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'batch-test-'));
    const filePath = path.join(tmp, 'b.wav');
    await writeFile(filePath, Buffer.from('b'));

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

    const { BatchRunner } = await import('./batchRunner.js');
    const store = memoryStore();
    const runner = new BatchRunner(store);
    await runner.init();
    const { jobId } = await runner.enqueue(
      'mock',
      'ja-JP',
      [{ path: filePath, originalname: 'b.wav', size: 1 }],
      { version: 1, language: 'ja-JP', items: [{ audio: 'a.wav', ref: 'ref' }] }
    );

    await new Promise((r) => setTimeout(r, 20));
    const status = runner.getStatus(jobId);

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

    const { BatchRunner } = await import('./batchRunner.js');
    const store = memoryStore();
    const runner = new BatchRunner(store);
    await runner.init();
    const { jobId } = await runner.enqueue('mock', 'ja-JP', [
      { path: filePathA, originalname: 'a.wav', size: 1 },
      { path: filePathB, originalname: 'b.wav', size: 1 },
    ]);

    await new Promise((r) => setTimeout(r, 30));
    const status = runner.getStatus(jobId);
    expect(status?.total).toBe(2);
    expect((status?.done ?? 0) + (status?.failed ?? 0)).toBe(2);
  });
});
