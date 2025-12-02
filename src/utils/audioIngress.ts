import { open, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { normalizeToPcmWav, AudioDecodeError } from './audioNormalizer.js';
import type { AppConfig } from '../types.js';

const PCM_FORMAT_TAG = 1;
const WAV_PROBE_BYTES = 4096;

export class AudioValidationError extends Error {
  code: 'AUDIO_UNSUPPORTED_FORMAT' | 'AUDIO_TOO_LONG';
  detail?: string;

  constructor(code: AudioValidationError['code'], message: string, detail?: string) {
    super(message);
    this.name = 'AudioValidationError';
    this.code = code;
    this.detail = detail;
  }
}

export interface AudioFormatInfo {
  container: 'wav' | 'unknown';
  formatTag?: number;
  formatName?: string;
  channels?: number;
  sampleRate?: number;
  bitsPerSample?: number;
  dataSize?: number;
  durationSec?: number;
}

export interface NormalizedAudio {
  normalizedPath: string;
  durationSec: number;
  bytes: number;
  degraded: boolean;
  generated: boolean;
  format?: AudioFormatInfo;
  signature: string;
  release: () => Promise<void>;
}

type CacheEntry = Omit<NormalizedAudio, 'release'> & { refCount: number };

const cache = new Map<string, CacheEntry>();

async function parseWavHeader(filePath: string): Promise<AudioFormatInfo | null> {
  const fd = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(WAV_PROBE_BYTES);
    const { bytesRead } = await fd.read(buffer, 0, WAV_PROBE_BYTES, 0);
    if (bytesRead < 12) return null;
    if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
      return null;
    }
    let offset = 12;
    let formatTag: number | undefined;
    let channels: number | undefined;
    let sampleRate: number | undefined;
    let bitsPerSample: number | undefined;
    let dataSize: number | undefined;

    while (offset + 8 <= bytesRead) {
      const id = buffer.toString('ascii', offset, offset + 4);
      const size = buffer.readUInt32LE(offset + 4);
      const chunkEnd = offset + 8 + size;
      if (chunkEnd > bytesRead) break;
      if (id === 'fmt ') {
        if (size >= 16) {
          formatTag = buffer.readUInt16LE(offset + 8);
          channels = buffer.readUInt16LE(offset + 10);
          sampleRate = buffer.readUInt32LE(offset + 12);
          bitsPerSample = buffer.readUInt16LE(offset + 22);
        }
      } else if (id === 'data') {
        dataSize = size;
      }
      offset = chunkEnd + (size % 2); // pad byte for odd sizes
    }

    const durationSec =
      dataSize && sampleRate && channels && bitsPerSample
        ? dataSize / (sampleRate * channels * (bitsPerSample / 8))
        : undefined;

    return {
      container: 'wav',
      formatTag,
      formatName: formatTag === PCM_FORMAT_TAG ? 'PCM' : 'unknown',
      channels,
      sampleRate,
      bitsPerSample,
      dataSize,
      durationSec,
    };
  } finally {
    await fd.close();
  }
}

function buildSignature(
  filePath: string,
  fileMtimeMs: number,
  fileSize: number,
  targetSampleRate: number,
  targetChannels: number,
  peakDbfs: number | undefined
): string {
  const absPath = path.resolve(filePath);
  const peakPart = typeof peakDbfs === 'number' ? `peak${peakDbfs}` : 'peakNone';
  return `${absPath}:${fileMtimeMs}:${fileSize}:sr${targetSampleRate}:ch${targetChannels}:${peakPart}`;
}

function matchesTarget(
  info: AudioFormatInfo | null,
  targetSampleRate: number,
  targetChannels: number
): boolean {
  if (!info) return false;
  return (
    info.container === 'wav' &&
    info.formatTag === PCM_FORMAT_TAG &&
    info.channels === targetChannels &&
    info.sampleRate === targetSampleRate &&
    info.bitsPerSample === 16
  );
}

export async function ensureNormalizedAudio(
  inputPath: string,
  options: {
    config: AppConfig;
    allowCache?: boolean;
    allowFallback?: boolean;
    tmpDir?: string;
    peakDbfs?: number;
  }
): Promise<NormalizedAudio> {
  const { config, allowCache = true, allowFallback = true, tmpDir, peakDbfs } = options;
  const stats = await stat(inputPath);
  const targetSampleRate = config.ingressNormalize?.targetSampleRate ?? config.audio.targetSampleRate;
  const targetChannels = config.ingressNormalize?.targetChannels ?? config.audio.targetChannels;
  const enabled = config.ingressNormalize?.enabled ?? true;
  const headroomDb = peakDbfs ?? config.ingressNormalize?.peakDbfs;
  const signature = buildSignature(
    inputPath,
    stats.mtimeMs,
    stats.size,
    targetSampleRate,
    targetChannels,
    headroomDb
  );

  if (allowCache) {
    const cached = cache.get(signature);
    if (cached && existsSync(cached.normalizedPath)) {
      cached.refCount += 1;
      return {
        ...cached,
        release: async () => {
          cached.refCount -= 1;
          if (cached.refCount <= 0) {
            cache.delete(signature);
            if (cached.generated) {
              await unlink(cached.normalizedPath).catch(() => undefined);
            }
          }
        },
      };
    }
  }

  const info = await parseWavHeader(inputPath);

  if (enabled && config.ingressNormalize?.maxDurationSec && info?.durationSec) {
    if (info.durationSec > config.ingressNormalize.maxDurationSec) {
      throw new AudioValidationError(
        'AUDIO_TOO_LONG',
        `audio duration exceeds limit (${config.ingressNormalize.maxDurationSec}s)`,
        `duration=${info.durationSec}`
      );
    }
  }

  const shouldNormalize = enabled ? !matchesTarget(info, targetSampleRate, targetChannels) : false;

  let resultPath = inputPath;
  let durationSec = info?.durationSec ?? 0;
  let degraded = false;
  let generated = false;
  let outputStats = stats;

  if (shouldNormalize) {
    try {
      const normalized = await normalizeToPcmWav(inputPath, {
        targetSampleRate,
        targetChannels,
        peakDbfs: headroomDb,
        allowFallback,
        tmpDir,
      });
      resultPath = normalized.normalizedPath;
      durationSec = normalized.durationSec;
      degraded = normalized.degraded;
      generated = resultPath !== inputPath;
      outputStats = await stat(resultPath);
    } catch (error) {
      if (error instanceof AudioDecodeError) {
        throw new AudioValidationError('AUDIO_UNSUPPORTED_FORMAT', 'audio decode failed', error.message);
      }
      throw error;
    }
  }

  const entry: CacheEntry = {
    normalizedPath: resultPath,
    durationSec,
    bytes: outputStats.size,
    degraded,
    generated,
    format: info ?? undefined,
    signature,
    refCount: 1,
  };

  if (allowCache) {
    cache.set(signature, entry);
  }

  return {
    ...entry,
    release: async () => {
      const current = cache.get(signature);
      if (allowCache && current) {
        current.refCount -= 1;
        if (current.refCount <= 0) {
          cache.delete(signature);
          if (current.generated) {
            await unlink(current.normalizedPath).catch(() => undefined);
          }
        }
        return;
      }
      if (!allowCache && generated) {
        await unlink(resultPath).catch(() => undefined);
      }
    },
  };
}
