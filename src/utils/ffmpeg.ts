import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Readable, Transform } from 'node:stream';
import { loadConfig } from '../config.js';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import type { AppConfig } from '../types.js';

export async function assertFfmpegAvailable(): Promise<void> {
  const ffmpegPath = ffmpegInstaller.path;
  const code = await new Promise<number>((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    proc.once('error', (err) => reject(err));
    proc.once('close', (exitCode) => resolve(exitCode ?? -1));
  }).catch((err) => {
    throw new Error(`ffmpeg not available: ${err instanceof Error ? err.message : String(err)}`);
  });

  if (code !== 0) {
    throw new Error(`ffmpeg not available: exited with code ${code}`);
  }
}

export function spawnPcmTranscoder(
  audioConfig: AppConfig['audio']
): {
  input: (chunk: Buffer) => Promise<void>;
  stream: Readable;
  end: () => void;
  onError: (cb: (err: Error) => void) => void;
  onClose: (cb: (code: number | null) => void) => void;
} {
  const ffmpegPath = ffmpegInstaller.path;
  const transcoder = spawn(
    ffmpegPath,
    [
      '-nostdin',
      '-hide_banner',
      '-v',
      'error',
      '-xerror',
      '-err_detect',
      'explode',
      '-use_wallclock_as_timestamps',
      '1',
      '-i',
      'pipe:0',
      '-ac',
      String(audioConfig.targetChannels),
      '-ar',
      String(audioConfig.targetSampleRate),
      '-f',
      's16le',
      'pipe:1',
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] }
  );

  const stream = transcoder.stdout;

  return {
    async input(chunk: Buffer) {
      if (!transcoder.stdin) return;
      const ok = transcoder.stdin.write(chunk);
      if (ok === false) {
        await once(transcoder.stdin, 'drain');
      }
    },
    stream,
    end() {
      transcoder.stdin?.end();
    },
    onError(cb: (err: Error) => void) {
      transcoder.once('error', cb);
    },
    onClose(cb: (code: number | null) => void) {
      transcoder.once('close', cb);
    },
  };
}

export type PcmChunkMeta = {
  captureTs: number;
  durationMs: number;
  seq?: number;
};

export type PcmResampler = {
  input: (chunk: Buffer, meta: PcmChunkMeta) => Promise<void>;
  onChunk: (cb: (chunk: Buffer, meta: PcmChunkMeta) => void) => void;
  end: () => void;
  onError: (cb: (err: Error) => void) => void;
  onClose: (cb: (code: number | null) => void) => void;
  readonly outputSampleRate: number;
};

export function createPcmResampler(options: {
  inputSampleRate: number;
  outputSampleRate: number;
  channels: number;
}): PcmResampler {
  const { inputSampleRate, outputSampleRate, channels } = options;
  const bytesPerSample = 2 * channels;

  if (inputSampleRate === outputSampleRate) {
    // Pass-through path keeps duration/captureTs untouched.
    let onChunkCb: ((chunk: Buffer, meta: PcmChunkMeta) => void) | null = null;
    return {
      async input(chunk, meta) {
        onChunkCb?.(chunk, { ...meta, seq: meta.seq ?? 0 });
      },
      onChunk(cb) {
        onChunkCb = cb;
      },
      end() {
        /* no-op */
      },
      onError() {
        /* no-op */
      },
      onClose() {
        /* no-op */
      },
      outputSampleRate,
    };
  }

  const ffmpegPath = ffmpegInstaller.path;
  const proc = spawn(
    ffmpegPath,
    [
      '-nostdin',
      '-hide_banner',
      '-v',
      'error',
      '-xerror',
      '-err_detect',
      'explode',
      '-f',
      's16le',
      '-ar',
      String(inputSampleRate),
      '-ac',
      String(channels),
      '-i',
      'pipe:0',
      '-ac',
      String(channels),
      '-ar',
      String(outputSampleRate),
      '-f',
      's16le',
      'pipe:1',
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] }
  );

  type MetaState = {
    // capture timestamp of the original input chunk (wall-clock ms), representing end-of-chunk.
    captureTs: number;
    durationMs: number;
    seq: number;
    expectedOutputSamples: number;
    sentOutputSamples: number;
    // derived timeline for resampled output so that emitted captureTs remains end-of-chunk.
    startTs: number;
    msPerSample: number;
  };

  const ratio = outputSampleRate / inputSampleRate;
  const metaQueue: MetaState[] = [];
  let onChunkCb: ((chunk: Buffer, meta: PcmChunkMeta) => void) | null = null;

  proc.stdout.on('data', (chunk: Buffer) => {
    if (!onChunkCb || metaQueue.length === 0) {
      return;
    }
    const totalSamples = Math.floor(chunk.length / bytesPerSample);
    let offsetSamples = 0;

    while (offsetSamples < totalSamples && metaQueue.length > 0) {
      const current = metaQueue[0];
      const remaining = current.expectedOutputSamples - current.sentOutputSamples;
      if (remaining <= 0) {
        metaQueue.shift();
        continue;
      }
      const takeSamples = Math.min(remaining, totalSamples - offsetSamples);
      const startByte = offsetSamples * bytesPerSample;
      const endByte = startByte + takeSamples * bytesPerSample;
      const slice = chunk.subarray(startByte, endByte);

      // The client/server protocol defines captureTs as end-of-chunk (wall-clock ms).
      // When resampling, ffmpeg may emit PCM in arbitrary buffer sizes, so we derive a stable
      // timeline based on the original chunk's duration and the expected resampled sample count.
      const chunkStartMs = current.startTs + current.sentOutputSamples * current.msPerSample;
      const chunkDurationMs = takeSamples * current.msPerSample;
      const chunkEndMs = chunkStartMs + chunkDurationMs;

      onChunkCb(slice, {
        captureTs: chunkEndMs,
        durationMs: chunkDurationMs,
        seq: current.seq,
      });

      current.sentOutputSamples += takeSamples;
      offsetSamples += takeSamples;

      if (current.sentOutputSamples >= current.expectedOutputSamples) {
        metaQueue.shift();
      }
    }
  });

  const write = async (chunk: Buffer, meta: PcmChunkMeta) => {
    if (!proc.stdin) return;
    const inputSamples = Math.floor(chunk.length / bytesPerSample);
    const expectedOutputSamples = Math.max(0, Math.round(inputSamples * ratio));
    const durationMs =
      Number.isFinite(meta.durationMs) && meta.durationMs > 0
        ? meta.durationMs
        : (inputSamples / inputSampleRate) * 1000;
    const captureTs = meta.captureTs;
    const msPerSample = expectedOutputSamples > 0 ? durationMs / expectedOutputSamples : 0;
    const startTs = captureTs - durationMs;
    metaQueue.push({
      captureTs,
      durationMs,
      seq: meta.seq ?? 0,
      expectedOutputSamples,
      sentOutputSamples: 0,
      startTs,
      msPerSample,
    });
    const ok = proc.stdin.write(chunk);
    if (ok === false) {
      await once(proc.stdin, 'drain');
    }
  };

  return {
    async input(chunk, meta) {
      await write(chunk, meta);
    },
    onChunk(cb) {
      onChunkCb = cb;
    },
    end() {
      proc.stdin?.end();
    },
    onError(cb) {
      proc.once('error', cb);
    },
    onClose(cb) {
      proc.once('close', cb);
    },
    outputSampleRate,
  };
}

export async function convertToPcmReadable(
  input: Buffer | Readable
): Promise<{ stream: Readable; durationPromise: Promise<number> }> {
  const config = await loadConfig();
  const ffmpegPath = ffmpegInstaller.path;
  const transcoder = spawn(
    ffmpegPath,
    [
      '-nostdin',
      '-hide_banner',
      '-v',
      'error',
      '-xerror',
      '-err_detect',
      'explode',
      '-i',
      'pipe:0',
      '-ac',
      String(config.audio.targetChannels),
      '-ar',
      String(config.audio.targetSampleRate),
      '-f',
      's16le',
      'pipe:1',
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] }
  );

  const source = Buffer.isBuffer(input) ? Readable.from(input) : input;
  source.on('error', (err) => transcoder.emit('error', err as Error));
  source.pipe(transcoder.stdin as NodeJS.WritableStream);

  let bytes = 0;
  let resolved = false;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      cb(null, chunk);
    },
  });

  const durationPromise = new Promise<number>((resolve, reject) => {
    const bytesPerSample = 2; // 16-bit linear PCM
    transcoder.stdout.on('end', () => {
      const durationSec = bytes / (config.audio.targetSampleRate * config.audio.targetChannels * bytesPerSample);
      resolved = true;
      resolve(durationSec);
    });

    transcoder.on('error', (err) => {
      if (!resolved) {
        reject(err);
      }
    });

    transcoder.on('close', (code) => {
      if (resolved) return;
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code ?? 'unknown'}`));
      }
    });
  });

  const stream = transcoder.stdout.pipe(counter);
  stream.on('error', () => {
    transcoder.kill('SIGKILL');
  });
  return { stream, durationPromise };
}

export async function resamplePcmBuffer(options: {
  buffer: Buffer;
  inputSampleRate: number;
  outputSampleRate: number;
  channels: number;
}): Promise<Buffer> {
  const { buffer, inputSampleRate, outputSampleRate, channels } = options;
  if (inputSampleRate === outputSampleRate) return buffer;
  const ffmpegPath = ffmpegInstaller.path;
  const args = [
    '-nostdin',
    '-hide_banner',
    '-v',
    'error',
    '-xerror',
    '-err_detect',
    'explode',
    '-f',
    's16le',
    '-ar',
    String(inputSampleRate),
    '-ac',
    String(channels),
    '-i',
    'pipe:0',
    '-ac',
    String(channels),
    '-ar',
    String(outputSampleRate),
    '-f',
    's16le',
    'pipe:1',
  ];

  const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  const chunks: Buffer[] = [];
  proc.stdout.on('data', (chunk) => chunks.push(chunk as Buffer));

  const completion = new Promise<void>((resolve, reject) => {
    proc.once('error', (err) => reject(err));
    proc.once('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exited with code ${code ?? 'unknown'}`));
    });
  });

  proc.stdin?.write(buffer);
  proc.stdin?.end();
  await completion;
  return Buffer.concat(chunks);
}

export async function transcodeFileToPcmWav(options: {
  inputPath: string;
  outputPath: string;
  sampleRate: number;
  channels: number;
}): Promise<void> {
  const ffmpegPath = ffmpegInstaller.path;
  const args = [
    '-nostdin',
    '-hide_banner',
    '-v',
    'error',
    '-xerror',
    '-err_detect',
    'explode',
    '-i',
    options.inputPath,
    '-ac',
    String(options.channels),
    '-ar',
    String(options.sampleRate),
    '-f',
    'wav',
    options.outputPath,
  ];
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'inherit'] });
    proc.once('error', (err) => reject(err));
    proc.once('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code ?? 'unknown'}`));
      }
    });
  });
}
