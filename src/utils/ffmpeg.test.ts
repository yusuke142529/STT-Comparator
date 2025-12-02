import { describe, expect, it, vi, afterEach } from 'vitest';

describe('spawnPcmTranscoder', () => {
  afterEach(() => {
    vi.clearAllMocks();
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
