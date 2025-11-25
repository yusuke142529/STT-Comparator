import type { StorageDriver, BatchJobFileResult } from '../types.js';
import { summarizeJob, JobSummary } from '../utils/summary.js';

export interface JobHistoryEntry {
  jobId: string;
  provider: string;
  lang: string;
  createdAt: string;
  updatedAt: string;
  total: number;
  summary: JobSummary;
}

export class JobHistory {
  private readonly rowsByJob = new Map<string, BatchJobFileResult[]>();

  constructor(private readonly storage: StorageDriver<BatchJobFileResult>) {}

  async init(): Promise<void> {
    await this.storage.init();
    await this.rebuild();
  }

  recordRow(record: BatchJobFileResult): void {
    if (!record.jobId) return;
    const bucket = this.rowsByJob.get(record.jobId) ?? [];
    bucket.push(record);
    this.rowsByJob.set(record.jobId, bucket);
  }

  async list(): Promise<JobHistoryEntry[]> {
    await this.syncWithStorage();
    return [...this.rowsByJob.entries()]
      .map(([jobId, rows]) => this.buildEntry(jobId, rows))
      .filter((entry): entry is JobHistoryEntry => Boolean(entry))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  get(jobId: string): BatchJobFileResult[] | undefined {
    return this.rowsByJob.get(jobId);
  }

  private buildEntry(jobId: string, rows: BatchJobFileResult[]): JobHistoryEntry | null {
    if (rows.length === 0) return null;
    const summary = summarizeJob(rows);
    const provider = rows[0].provider;
    const lang = rows[0].lang;
    const createdAt = this.getEarliest(rows)?.createdAt ?? new Date().toISOString();
    const updatedAt = this.getLatest(rows)?.createdAt ?? createdAt;
    return {
      jobId,
      provider,
      lang,
      createdAt,
      updatedAt,
      total: rows.length,
      summary,
    };
  }

  private getEarliest(rows: BatchJobFileResult[]): BatchJobFileResult | null {
    return rows.reduce<BatchJobFileResult | null>((prev, current) => {
      if (!prev) return current;
      const prevTs = Date.parse(prev.createdAt ?? '');
      const currentTs = Date.parse(current.createdAt ?? '');
      return Number.isFinite(currentTs) && currentTs < (Number.isFinite(prevTs) ? prevTs : Infinity) ? current : prev;
    }, null);
  }

  private getLatest(rows: BatchJobFileResult[]): BatchJobFileResult | null {
    return rows.reduce<BatchJobFileResult | null>((prev, current) => {
      if (!prev) return current;
      const prevTs = Date.parse(prev.createdAt ?? '');
      const currentTs = Date.parse(current.createdAt ?? '');
      return Number.isFinite(currentTs) && currentTs > (Number.isFinite(prevTs) ? prevTs : -Infinity) ? current : prev;
    }, null);
  }

  private async rebuild(): Promise<void> {
    const all = await this.storage.readAll();
    this.rowsByJob.clear();
    all.forEach((row) => this.recordRow(row));
  }

  private async syncWithStorage(): Promise<void> {
    const reader = this.storage.readByJob;
    if (typeof reader !== 'function') {
      return;
    }

    const jobIds = [...this.rowsByJob.keys()];
    const synced = await Promise.all(
      jobIds.map(async (jobId) => ({
        jobId,
        rows: await reader(jobId),
      }))
    );

    for (const { jobId, rows } of synced) {
      if (rows.length === 0) {
        this.rowsByJob.delete(jobId);
      } else {
        this.rowsByJob.set(jobId, rows);
      }
    }
  }
}
