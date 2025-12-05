import type { StorageDriver, BatchJobFileResult } from '../types.js';
import { summarizeJob, summarizeJobByProvider } from '../utils/summary.js';
import type { JobSummary } from '../utils/summary.js';

export interface JobHistoryEntry {
  jobId: string;
  provider: string;
  providers: string[];
  lang: string;
  createdAt: string;
  updatedAt: string;
  total: number;
  summary: JobSummary;
  summaryByProvider?: Record<string, JobSummary>;
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
    const summaryByProvider = summarizeJobByProvider(rows);
    const providers = Array.from(new Set(rows.map((row) => row.provider)));
    const provider = providers[0];
    const lang = rows[0].lang;
    const createdAt = this.getEarliest(rows)?.createdAt ?? new Date().toISOString();
    const updatedAt = this.getLatest(rows)?.createdAt ?? createdAt;
    return {
      jobId,
      provider,
      providers,
      lang,
      createdAt,
      updatedAt,
      total: rows.length,
      summary,
      summaryByProvider,
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

  private mapByJob(rows: BatchJobFileResult[]): Map<string, BatchJobFileResult[]> {
    const result = new Map<string, BatchJobFileResult[]>();
    for (const row of rows) {
      if (!row.jobId) continue;
      const bucket = result.get(row.jobId);
      if (bucket) {
        bucket.push(row);
      } else {
        result.set(row.jobId, [row]);
      }
    }
    return result;
  }

  private rebuildFrom(rows: BatchJobFileResult[]): void {
    this.rowsByJob.clear();
    for (const [jobId, records] of this.mapByJob(rows)) {
      this.rowsByJob.set(jobId, records);
    }
  }

  private async rebuild(): Promise<void> {
    const all = await this.storage.readAll();
    this.rebuildFrom(all);
  }

  private async syncWithStorage(): Promise<void> {
    const currentRows = await this.storage.readAll();
    const grouped = this.mapByJob(currentRows);

    // align in-memory map with storage contents in linear time
    for (const jobId of [...this.rowsByJob.keys()]) {
      if (!grouped.has(jobId)) {
        this.rowsByJob.delete(jobId);
      }
    }
    for (const [jobId, records] of grouped) {
      this.rowsByJob.set(jobId, records);
    }
  }
}
