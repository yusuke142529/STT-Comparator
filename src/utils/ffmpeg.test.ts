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
