import { randomUUID } from 'node:crypto';
import { unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

const BYTES_PER_SAMPLE = 2; // 16-bit PCM
const MIN_DURATION_SEC = 0.1; // avoid near-empty outputs that slip through

export class AudioDecodeError extends Error {
  stderr?: string;

  constructor(message: string, stderr?: string) {
    super(message);
    this.name = 'AudioDecodeError';
    this.stderr = stderr;
  }
}

export type NormalizeResult = {
  normalizedPath: string;
  durationSec: number;
  bytes: number;
  degraded: boolean;
  stderr?: string;
};

export type NormalizeOptions = {
  targetSampleRate?: number;
  targetChannels?: number;
  peakDbfs?: number;
  allowFallback?: boolean;
  tmpDir?: string;
};

/**
 * Normalize an arbitrary input file into 16k mono PCM WAV with strict decode checks.
 * Throws AudioDecodeError on any ffmpeg decoding issue or too-short output.
 */
export async function normalizeToPcmWav(
  inputPath: string,
  options?: NormalizeOptions
): Promise<NormalizeResult> {
  const targetSampleRate = options?.targetSampleRate ?? 16000;
  const targetChannels = options?.targetChannels ?? 1;
  const outputPath = path.join(options?.tmpDir ?? tmpdir(), `stt-normalized-${randomUUID()}.wav`);
  const ffmpegPath = ffmpegInstaller.path;
  const headroom = options?.peakDbfs;

  const buildArgs = (strict: boolean): string[] => {
    const args = [
      '-nostdin',
      '-hide_banner',
      '-v',
      strict ? 'error' : 'warning',
      ...(strict ? ['-xerror', '-err_detect', 'explode'] : []),
      '-i',
      inputPath,
      '-vn',
      '-sn',
      '-dn',
      '-ac',
      String(targetChannels),
      '-ar',
      String(targetSampleRate),
    ];
    if (typeof headroom === 'number') {
      args.push('-af', `volume=${headroom}dB`);
    }
    args.push('-f', 'wav', outputPath);
    return args;
  };

  const attempt = async (args: string[], degraded: boolean) => {
    let stderrBuf = '';
    const code = await new Promise<number>((resolve, reject) => {
      const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      proc.stderr?.on('data', (chunk) => {
        stderrBuf += chunk.toString();
      });
      proc.once('error', (err) => reject(err));
      proc.once('close', (exitCode) => resolve(exitCode ?? -1));
    }).catch((err) => {
      throw new AudioDecodeError('audio decode failed', err instanceof Error ? err.message : String(err));
    });

    if (code !== 0) {
      await unlink(outputPath).catch(() => undefined);
      throw new AudioDecodeError('audio decode failed (ffmpeg non-zero exit)', stderrBuf.trim());
    }

    const stats = await stat(outputPath);
    const bytes = stats.size;
    const durationSec = bytes / (targetSampleRate * targetChannels * BYTES_PER_SAMPLE);

    if (!Number.isFinite(durationSec) || durationSec < MIN_DURATION_SEC) {
      await unlink(outputPath).catch(() => undefined);
      throw new AudioDecodeError('decoded audio is too short or empty', stderrBuf.trim());
    }

    return { normalizedPath: outputPath, durationSec, bytes, degraded, stderr: stderrBuf.trim() };
  };

  try {
    return await attempt(buildArgs(true), false);
  } catch (strictErr) {
    if (options?.allowFallback === false) throw strictErr;
    // Clean any partial output before retry
    await unlink(outputPath).catch(() => undefined);
    return attempt(buildArgs(false), true);
  }
}
