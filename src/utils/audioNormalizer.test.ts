import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { writeFile, unlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { normalizeToPcmWav, AudioDecodeError } from './audioNormalizer.js';

const generated: string[] = [];

afterEach(async () => {
  await Promise.all(
    generated.map((p) =>
      unlink(p).catch(() => undefined)
    )
  );
  generated.length = 0;
});

const makeTmp = (suffix: string) => {
  const p = path.join(tmpdir(), `stt-test-${randomUUID()}${suffix}`);
  generated.push(p);
  return p;
};

const generateTone = async (durationSec = 0.2) => {
  const out = makeTmp('.wav');
  const args = [
    '-nostdin',
    '-hide_banner',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${durationSec}`,
    '-ac',
    '1',
    '-ar',
    '16000',
    out,
  ];
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegInstaller.path, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    proc.once('error', reject);
    proc.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}`));
    });
  });
  return out;
};

describe('normalizeToPcmWav', () => {
  it('produces 16k mono PCM wav from valid audio', async () => {
    const input = await generateTone(0.25);
    const { normalizedPath, durationSec, bytes } = await normalizeToPcmWav(input);
    generated.push(normalizedPath);
    const stats = await stat(normalizedPath);

    expect(stats.size).toBeGreaterThan(0);
    expect(bytes).toBe(stats.size);
    expect(durationSec).toBeGreaterThan(0.2);
    expect(durationSec).toBeLessThan(0.4);
  });

  it('throws AudioDecodeError for non-audio inputs', async () => {
    const bogus = makeTmp('.txt');
    await writeFile(bogus, 'not audio at all');

    await expect(normalizeToPcmWav(bogus)).rejects.toBeInstanceOf(AudioDecodeError);
  });
});
