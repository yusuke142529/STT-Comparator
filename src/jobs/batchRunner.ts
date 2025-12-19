import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { buffer as streamToBuffer } from 'node:stream/consumers';
import type {
  BatchJobFileResult,
  EvaluationManifest,
  NormalizationConfig,
  ProviderId,
  StorageDriver,
  StreamingOptions,
  TranscriptionOptions,
} from '../types.js';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { getAdapter } from '../adapters/index.js';
import { convertToPcmReadable } from '../utils/ffmpeg.js';
import { ensureNormalizedAudio, AudioValidationError } from '../utils/audioIngress.js';
import { AudioDecodeError } from '../utils/audioNormalizer.js';
import { cer, rtf, wer } from '../scoring/metrics.js';
import { matchManifestItem, ManifestMatchError } from '../utils/manifest.js';
import os from 'node:os';
import type { JobHistory } from './jobHistory.js';
import type { JobExportService } from './jobExportService.js';

interface FileInput {
  originalname: string;
  path: string;
  size?: number;
}

interface JobState {
  id: string;
  providers: ProviderId[];
  lang: string;
  total: number;
  files: FileInput[];
  done: number;
  failed: number;
  results: BatchJobFileResult[];
  manifest?: EvaluationManifest;
  options?: TranscriptionOptions;
  normalization?: NormalizationConfig;
  errors: { file: string; message: string }[];
}

interface PreparedFile {
  normalization: Awaited<ReturnType<typeof ensureNormalizedAudio>>;
  refText?: string;
  durationSec: number;
  degraded: boolean;
  pcmBuffer: Buffer;
  pcmSampleRate: number;
}

export class BatchRunner {
  private jobs = new Map<string, JobState>();
  private cleanupTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private storage: StorageDriver<BatchJobFileResult>,
    private readonly jobHistory: JobHistory,
    private readonly jobExporter?: JobExportService
  ) {}

  async init(): Promise<void> {
    await this.storage.init();
  }

  async enqueue(
    providers: ProviderId[],
    lang: string,
    files: FileInput[],
    manifest?: EvaluationManifest,
    options?: TranscriptionOptions
  ): Promise<{ jobId: string; queued: number }> {
    if (files.length === 0) {
      throw new Error('No files uploaded');
    }

    const config = await loadConfig();
    const uniqProviders = Array.from(new Set(providers));
    const jobId = randomUUID();
    const job: JobState = {
      id: jobId,
      providers: uniqProviders,
      lang,
      total: files.length * uniqProviders.length,
      files,
      done: 0,
      failed: 0,
      results: [],
      manifest,
      options,
      normalization: manifest?.normalization ?? config.normalization,
      errors: [],
    };
    this.jobs.set(jobId, job);
    void this.processJob(job);
    return { jobId, queued: files.length };
  }

  getStatus(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    return {
      jobId,
      total: job.total,
      done: job.done,
      failed: job.failed,
      errors: job.errors,
      providers: job.providers,
    };
  }

  async getResults(jobId: string): Promise<BatchJobFileResult[] | null> {
    const job = this.jobs.get(jobId);
    if (job) return job.results;
    if (typeof this.storage.readByJob === 'function') {
      const stored = await this.storage.readByJob(jobId);
      if (stored.length > 0) return stored;
    }
    return null;
  }

  private async processJob(job: JobState): Promise<void> {
    let config: Awaited<ReturnType<typeof loadConfig>> | null = null;
    try {
      const loadedConfig = await loadConfig();
      config = loadedConfig;

      const cpuCount = Math.max(1, os.cpus().length || 1);
      const maxParallel = Math.min(cpuCount, loadedConfig.jobs?.maxParallel ?? cpuCount);
      const providerCount = job.providers.length;
      const requestedParallel = Math.max(1, job.options?.parallel ?? 1);
      // options.parallel = files in flight. We need providerCount slots per file so
      // side-by-side comparison sees identical timing. Clamp by maxParallel / CPU.
      const desiredSlots = providerCount * requestedParallel;
      const effectiveSlots = Math.min(maxParallel, Math.max(providerCount, desiredSlots));
      // number of files processed concurrently; at least 1
      const fileConcurrency = Math.max(1, Math.floor(effectiveSlots / providerCount) || 1);
      // providers per file allowed to run simultaneously; keep total <= maxParallel
      const providerConcurrency = Math.max(
        1,
        Math.min(providerCount, Math.floor(maxParallel / fileConcurrency) || providerCount)
      );
      if (providerConcurrency < providerCount || fileConcurrency * providerConcurrency < desiredSlots) {
        logger.warn({
          event: 'batch_parallel_clamped',
          providers: providerCount,
          requestedParallelFiles: requestedParallel,
          effectiveSlots,
          maxParallel,
          fileConcurrency,
          providerConcurrency,
        });
      }

      let fileCursor = 0;

      const runProvidersWithLimit = async (
        providers: ProviderId[],
        limit: number,
        fn: (provider: ProviderId) => Promise<void>
      ) => {
        let idx = 0;
        const providerWorker = async () => {
          while (idx < providers.length) {
            const current = providers[idx];
            idx += 1;
            await fn(current);
          }
        };
        await Promise.all(Array.from({ length: limit }, () => providerWorker()));
      };

      const fileWorker = async () => {
        while (fileCursor < job.files.length) {
          const index = fileCursor;
          fileCursor += 1;
          const file = job.files[index];
          if (!file) break;

          let prepared: PreparedFile | null = null;
          try {
            prepared = await this.prepareFile(file, job, loadedConfig);
          } catch (error) {
            const message =
              error instanceof ManifestMatchError
                ? error.message
                : error instanceof AudioValidationError || error instanceof AudioDecodeError
                  ? 'audio decode failed (unsupported or corrupted file)'
                  : error instanceof Error
                    ? error.message
                    : 'Unknown adapter error';
            job.failed += providerCount;
            job.errors.push({ file: `${file.originalname} (all providers)`, message });
            logger.error({
              event: 'batch_failed',
              file: file.originalname,
              provider: 'all',
              message,
            });
            await this.cleanupPreparedFile(file, prepared);
            continue;
          }

          await runProvidersWithLimit(job.providers, providerConcurrency, async (provider) => {
            try {
              await this.runProviderTask(file, provider, prepared as PreparedFile, job, loadedConfig);
            } catch (error) {
              const message =
                error instanceof ManifestMatchError
                  ? error.message
                  : error instanceof AudioValidationError || error instanceof AudioDecodeError
                    ? 'audio decode failed (unsupported or corrupted file)'
                    : error instanceof Error
                      ? error.message
                      : 'Unknown adapter error';
              job.failed += 1;
              job.errors.push({ file: `${file.originalname} (${provider})`, message });
              logger.error({
                event: 'batch_failed',
                file: file.originalname,
                provider,
                message,
              });
            }
          });

          await this.cleanupPreparedFile(file, prepared);
        }
      };

      const workers = Array.from({ length: fileConcurrency }, () => fileWorker());
      const settled = await Promise.allSettled(workers);
      const rejected = settled.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      if (rejected.length > 0) {
        throw rejected[0].reason instanceof Error ? rejected[0].reason : new Error('batch worker failed');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown batch runner error';
      logger.error({ event: 'batch_job_failed', jobId: job.id, message });

      // Ensure the job completes (so status polling doesn't hang) and cleanup any remaining temp uploads.
      const remaining = Math.max(0, job.total - job.done - job.failed);
      if (remaining > 0) {
        job.failed += remaining;
      }
      job.errors.push({ file: '(job)', message });
      await Promise.all(job.files.map((f) => unlink(f.path).catch(() => undefined)));
    } finally {
      if (this.jobExporter && job.results.length > 0) {
        try {
          await this.jobExporter.export(job.id, job.results);
        } catch {
          // errors already logged by JobExportService
        }
      }

      // release heavy references and schedule eviction
      job.files = [];
      job.manifest = undefined;
      job.options = undefined;

      const retentionMs = config?.jobs?.retentionMs ?? 10 * 60 * 1000;
      const timer = setTimeout(() => {
        this.jobs.delete(job.id);
        this.cleanupTimers.delete(job.id);
      }, retentionMs);
      this.cleanupTimers.set(job.id, timer);
    }
  }

  private async prepareFile(
    file: FileInput,
    job: JobState,
    config: Awaited<ReturnType<typeof loadConfig>>
  ): Promise<PreparedFile> {
    const manifestItem = job.manifest ? matchManifestItem(job.manifest, file.originalname) : undefined;
    if (job.manifest && !manifestItem) {
      throw new ManifestMatchError('manifest ref not found for file');
    }

    const normalization = await ensureNormalizedAudio(file.path, { config, allowCache: true });
    let sourceStream: ReturnType<typeof createReadStream> | null = null;
    try {
      sourceStream = createReadStream(normalization.normalizedPath);
      await once(sourceStream, 'open');
      const { stream: pcmStream, durationPromise } = await convertToPcmReadable(sourceStream);
      const pcmBuffer = await streamToBuffer(pcmStream);
      const durationSec = normalization.durationSec ?? (await durationPromise);
      if (!durationSec || !Number.isFinite(durationSec)) {
        throw new Error('duration could not be determined');
      }

      return {
        normalization,
        refText: manifestItem?.ref,
        durationSec,
        degraded: normalization.degraded,
        pcmBuffer,
        pcmSampleRate: config.audio.targetSampleRate,
      };
    } catch (error) {
      sourceStream?.destroy();
      await normalization.release().catch(() => undefined);
      throw error;
    }
  }

  private async runProviderTask(
    file: FileInput,
    provider: ProviderId,
    prepared: PreparedFile,
    job: JobState,
    config: Awaited<ReturnType<typeof loadConfig>>
  ): Promise<void> {
    const adapter = getAdapter(provider);
    // Batch evaluation uses a fixed, config-defined PCM spec (fairness baseline).
    const sampleRateHz = config.audio.targetSampleRate;
    const streamingOpts: StreamingOptions = {
      language: job.lang,
      sampleRateHz,
      encoding: 'linear16',
      enableInterim: false,
      contextPhrases: job.options?.dictionaryPhrases,
      punctuationPolicy: job.options?.punctuationPolicy,
      enableVad: job.options?.enableVad ?? false,
      dictionaryPhrases: job.options?.dictionaryPhrases,
    };

    const pcmStream = Readable.from(prepared.pcmBuffer);
    const start = Date.now();
    const batchResult = await adapter.transcribeFileFromPCM(pcmStream, streamingOpts);
    const processingTimeMs = Date.now() - start; // server-measured wall clock
    const computedDuration =
      prepared.pcmBuffer.length / (2 * config.audio.targetChannels * sampleRateHz);
    const adapterDurationSec =
      typeof batchResult.durationSec === 'number' &&
      Number.isFinite(batchResult.durationSec) &&
      batchResult.durationSec > 0
        ? batchResult.durationSec
        : undefined;
    const durationSec = adapterDurationSec ?? prepared.durationSec ?? computedDuration;

    const baseNormalization = job.normalization ?? config.normalization;
    const isJapanese = job.lang.trim().toLowerCase().startsWith('ja');
    // Scoring policy:
    // - Japanese: CER is the primary metric; WER is omitted (word boundaries are not meaningful).
    // - Non-Japanese: WER is the primary metric; enforce stripSpace=false so tokenization remains valid.
    const normalization = isJapanese ? baseNormalization : { ...baseNormalization, stripSpace: false };
    if (!isJapanese && baseNormalization.stripSpace === true) {
      logger.warn({ event: 'batch_strip_space_forced_off_for_wer', file: file.originalname });
    }
    const score: BatchJobFileResult = {
      jobId: job.id,
      path: file.originalname,
      provider,
      lang: job.lang,
      durationSec,
      processingTimeMs,
      rtf: durationSec ? rtf(processingTimeMs, durationSec) : 0,
      cer: prepared.refText ? cer(prepared.refText, batchResult.text, normalization) : undefined,
      wer: prepared.refText && !isJapanese ? wer(prepared.refText, batchResult.text, normalization) : undefined,
      latencyMs: processingTimeMs,
      text: batchResult.text,
      refText: prepared.refText,
      degraded: prepared.degraded,
      createdAt: new Date().toISOString(),
      opts: job.options as Record<string, unknown>,
      vendorProcessingMs: batchResult.vendorProcessingMs,
      normalizationUsed: normalization,
    };
    await this.storage.append(score);
    job.results.push(score);
    this.jobHistory.recordRow(score);
    job.done += 1;
  }

  private async cleanupPreparedFile(file: FileInput, prepared: PreparedFile | null): Promise<void> {
    if (prepared?.normalization) {
      await prepared.normalization.release().catch(() => undefined);
    }
    if (file.path) {
      await unlink(file.path).catch(() => undefined);
    }
  }
}
