import { describe, expect, it, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

describe('spawnPcmTranscoder', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.doUnmock('node:child_process');
    vi.doUnmock('@ffmpeg-installer/ffmpeg');
    vi.resetModules();
  });

  it('config のサンプルレートとチャネルを ffmpeg に反映する', async () => {
    const spawn = vi.fn(() => ({ stdout: {}, stdin: { write: vi.fn(), end: vi.fn() } }));
    vi.doMock('node:child_process', () => ({ spawn }));
    vi.doMock('@ffmpeg-installer/ffmpeg', () => ({
      default: { path: '/bin/ffmpeg' },
      path: '/bin/ffmpeg',
    }));

    const { spawnPcmTranscoder } = await import('./ffmpeg.js');
    spawnPcmTranscoder({ targetSampleRate: 8000, targetChannels: 2, chunkMs: 250 });

    const args = ((spawn.mock.calls as any)[0]?.[1] ?? []) as string[];
    expect(args).toContain('-ar');
    expect(args).toContain('8000');
    expect(args).toContain('-ac');
    expect(args).toContain('2');
  });
});

describe('transcodeFileToPcmWav', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.doUnmock('node:child_process');
    vi.doUnmock('@ffmpeg-installer/ffmpeg');
    vi.resetModules();
  });

  it('spawns ffmpeg with wav output and expected sample rate/channels', async () => {
    const spawn = vi.fn(() => ({
      once: (event: string, cb: (arg?: unknown) => void) => {
        if (event === 'close') cb(0);
        return undefined;
      },
    }));
    vi.doMock('node:child_process', () => ({ spawn }));
    vi.doMock('@ffmpeg-installer/ffmpeg', () => ({
      default: { path: '/bin/ffmpeg' },
      path: '/bin/ffmpeg',
    }));

    const { transcodeFileToPcmWav } = await import('./ffmpeg.js');
    await transcodeFileToPcmWav({
      inputPath: '/tmp/in.wav',
      outputPath: '/tmp/out.wav',
      sampleRate: 16000,
      channels: 1,
    });

    const args = ((spawn.mock.calls as any)[0]?.[1] ?? []) as string[];
    expect(args).toEqual([
      '-nostdin',
      '-hide_banner',
      '-v',
      'error',
      '-xerror',
      '-err_detect',
      'explode',
      '-i',
      '/tmp/in.wav',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-f',
      'wav',
      '/tmp/out.wav',
    ]);
  });
});

describe('createPcmResampler', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.doUnmock('node:child_process');
    vi.doUnmock('@ffmpeg-installer/ffmpeg');
    vi.resetModules();
  });

  it('パススルー時は captureTs/durationMs を変更しない', async () => {
    const { createPcmResampler } = await import('./ffmpeg.js');
    const resampler = createPcmResampler({ inputSampleRate: 16000, outputSampleRate: 16000, channels: 1 });
    const onChunk = vi.fn();
    resampler.onChunk(onChunk);
    await resampler.input(Buffer.from([1, 2, 3, 4]), { captureTs: 1000, durationMs: 250 });
    expect(onChunk).toHaveBeenCalledTimes(1);
    const [, meta] = onChunk.mock.calls[0] as [Buffer, { captureTs: number; durationMs: number; seq: number }];
    expect(meta.captureTs).toBe(1000);
    expect(meta.durationMs).toBe(250);
    expect(meta.seq).toBe(0);
  });

  it('リサンプル時も captureTs を end-of-chunk として維持する', async () => {
    const stdout = new EventEmitter();
    const stdin = Object.assign(new EventEmitter(), {
      write: vi.fn(() => true),
      end: vi.fn(),
    });
    const proc = Object.assign(new EventEmitter(), { stdout, stdin });
    const spawn = vi.fn(() => proc);
    vi.doMock('node:child_process', () => ({ spawn }));
    vi.doMock('@ffmpeg-installer/ffmpeg', () => ({
      default: { path: '/bin/ffmpeg' },
      path: '/bin/ffmpeg',
    }));

    const { createPcmResampler } = await import('./ffmpeg.js');
    const resampler = createPcmResampler({ inputSampleRate: 16000, outputSampleRate: 24000, channels: 1 });

    const calls: Array<{ captureTs: number; durationMs: number; seq: number; bytes: number }> = [];
    resampler.onChunk((chunk, meta) => {
      calls.push({ captureTs: meta.captureTs, durationMs: meta.durationMs, seq: meta.seq ?? 0, bytes: chunk.length });
    });

    // 16kHz * 250ms = 4000 samples => 8000 bytes (mono 16-bit).
    await resampler.input(Buffer.alloc(8000), { captureTs: 1000, durationMs: 250, seq: 7 });

    // Expected output samples: 4000 * 1.5 = 6000 => 12000 bytes.
    // Emit it in two pieces to simulate arbitrary ffmpeg stdout chunking.
    stdout.emit('data', Buffer.alloc(6000)); // 3000 samples
    stdout.emit('data', Buffer.alloc(6000)); // 3000 samples

    expect(calls.length).toBe(2);
    // Each half should be ~125ms, with end timestamps 875ms and 1000ms.
    expect(calls[0]?.seq).toBe(7);
    expect(calls[0]?.durationMs).toBeCloseTo(125, 6);
    expect(calls[0]?.captureTs).toBeCloseTo(875, 6);
    expect(calls[1]?.seq).toBe(7);
    expect(calls[1]?.durationMs).toBeCloseTo(125, 6);
    expect(calls[1]?.captureTs).toBeCloseTo(1000, 6);
  });
});
