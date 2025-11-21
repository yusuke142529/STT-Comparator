import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Readable, Transform } from 'node:stream';
import { loadConfig } from '../config.js';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import type { AppConfig } from '../types.js';

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
      '-f',
      'webm',
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

export async function convertToPcmReadable(
  input: Buffer | Readable
): Promise<{ stream: Readable; durationPromise: Promise<number> }> {
  const config = await loadConfig();
  const ffmpegPath = ffmpegInstaller.path;
  const transcoder = spawn(
    ffmpegPath,
    [
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
