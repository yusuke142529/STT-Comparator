import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { once } from 'node:events';
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
import { matchManifestItem } from '../utils/manifest.js';
import os from 'node:os';
import type { JobHistory } from './jobHistory.js';
import { JobExportService } from './jobExportService.js';

interface FileInput {
  originalname: string;
  path: string;
  size?: number;
}

interface JobState {
  id: string;
  provider: ProviderId;
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
    provider: ProviderId,
    lang: string,
    files: FileInput[],
    manifest?: EvaluationManifest,
    options?: TranscriptionOptions
  ): Promise<{ jobId: string; queued: number }> {
    if (files.length === 0) {
      throw new Error('No files uploaded');
    }

    const config = await loadConfig();
    const jobId = randomUUID();
    const job: JobState = {
      id: jobId,
      provider,
      lang,
      total: files.length,
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
    return { jobId, total: job.total, done: job.done, failed: job.failed, errors: job.errors };
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
    const config = await loadConfig();
    const adapter = getAdapter(job.provider);
    const cpuCount = Math.max(1, os.cpus().length || 1);
    const maxParallel = Math.min(cpuCount, config.jobs?.maxParallel ?? cpuCount);
    const requestedParallel = job.options?.parallel ?? 1;
    const concurrency = Math.min(Math.max(1, requestedParallel), maxParallel);
    let cursor = 0;

    const worker = async () => {
      while (cursor < job.files.length) {
        const index = cursor;
        cursor += 1;
        const file = job.files[index];
        if (!file) break;
        await this.processSingleFile(file, job, adapter, config);
      }
    };

    const workers = Array.from({ length: concurrency }, () => worker());
    await Promise.all(workers);

    if (this.jobExporter) {
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

    const retentionMs = config.jobs?.retentionMs ?? 10 * 60 * 1000;
    const timer = setTimeout(() => {
      this.jobs.delete(job.id);
      this.cleanupTimers.delete(job.id);
    }, retentionMs);
    this.cleanupTimers.set(job.id, timer);
  }

  private async processSingleFile(
    file: FileInput,
    job: JobState,
    adapter: ReturnType<typeof getAdapter>,
    config: Awaited<ReturnType<typeof loadConfig>>
  ): Promise<void> {
    let sourceStream: Readable | null = null;
    let normalizedPath: string | null = null;
    let normalizationResult: Awaited<ReturnType<typeof ensureNormalizedAudio>> | null = null;
    try {
      const manifestItem = job.manifest ? matchManifestItem(job.manifest, file.originalname) : undefined;
      if (job.manifest && !manifestItem) {
        job.failed += 1;
        job.errors.push({ file: file.originalname, message: 'manifest ref not found for file' });
        return;
      }

      normalizationResult = await ensureNormalizedAudio(file.path, { config, allowCache: true });
      normalizedPath = normalizationResult.normalizedPath;

      sourceStream = createReadStream(normalizedPath);
      await once(sourceStream, 'open');
      const { stream: pcmStream, durationPromise } = await convertToPcmReadable(sourceStream);
      const maxParallel = Math.min(os.cpus().length, config.jobs?.maxParallel ?? 4);
      const streamingOpts: StreamingOptions = {
        language: job.lang,
        sampleRateHz: config.audio.targetSampleRate,
        encoding: 'linear16',
        enableInterim: false,
        contextPhrases: job.options?.dictionaryPhrases,
        punctuationPolicy: job.options?.punctuationPolicy,
        enableVad: job.options?.enableVad,
        dictionaryPhrases: job.options?.dictionaryPhrases,
        parallel: Math.min(job.options?.parallel ?? 1, maxParallel),
      };
      const start = Date.now();
      const batchResult = await adapter.transcribeFileFromPCM(pcmStream, streamingOpts);
      const processingTimeMs = Date.now() - start; // server-measured wall clock
      const durationSec = batchResult.durationSec ?? normalizationResult.durationSec ?? (await durationPromise);
      if (!durationSec || !Number.isFinite(durationSec)) {
        job.failed += 1;
        job.errors.push({ file: file.originalname, message: 'duration could not be determined' });
        return;
      }
      const refText = manifestItem?.ref;
      const normalization = job.normalization ?? config.normalization;

      const score: BatchJobFileResult = {
        jobId: job.id,
        path: file.originalname,
        provider: job.provider,
        lang: job.lang,
        durationSec,
        processingTimeMs,
        rtf: durationSec ? rtf(processingTimeMs, durationSec) : 0,
        cer: refText ? cer(refText, batchResult.text, normalization) : undefined,
        wer: refText ? wer(refText, batchResult.text, normalization) : undefined,
        // latency is always server-measured wall clock for fairness
        latencyMs: processingTimeMs,
        text: batchResult.text,
        refText,
        createdAt: new Date().toISOString(),
        opts: job.options as Record<string, unknown>,
        vendorProcessingMs: batchResult.vendorProcessingMs,
      };
      job.results.push(score);
      await this.storage.append(score);
      this.jobHistory.recordRow(score);
      job.done += 1;
    } catch (error) {
      const message =
        error instanceof AudioValidationError || error instanceof AudioDecodeError
          ? 'audio decode failed (unsupported or corrupted file)'
          : error instanceof Error
            ? error.message
            : 'Unknown adapter error';
      logger.error({
        event: 'batch_failed',
        file: file.originalname,
        message,
      });
      job.failed += 1;
      job.errors.push({ file: file.originalname, message });
    } finally {
      sourceStream?.destroy();
      if (normalizationResult) {
        void normalizationResult.release().catch(() => undefined);
      }
      if (file.path) {
        void unlink(file.path).catch(() => undefined);
      }
    }
  }
}
