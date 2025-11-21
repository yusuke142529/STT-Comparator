import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StorageDriver } from '../types.js';
import type { RetentionPolicy } from './retention.js';

export class JsonlStore<T> implements StorageDriver<T> {
  private readonly retentionMs: number | undefined;
  private readonly maxRows: number | undefined;
  private readonly pruneIntervalMs: number;
  private lastPruned = 0;

  constructor(private filepath: string, retention?: RetentionPolicy) {
    this.retentionMs = retention?.retentionMs;
    this.maxRows = retention?.maxRows;
    this.pruneIntervalMs = retention?.pruneIntervalMs ?? 5 * 60 * 1000; // 5 minutes
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.filepath), { recursive: true });
  }

  async append(record: T): Promise<void> {
    await appendFile(this.filepath, `${JSON.stringify(record)}\n`);
    await this.maybePrune(record);
  }

  async readAll(): Promise<T[]> {
    try {
      const data = await readFile(this.filepath, 'utf-8');
      return data
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as T);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async readRecent(limit: number): Promise<T[]> {
    const all = await this.readAll();
    if (limit <= 0) return all;
    return all.slice(-limit).reverse();
  }

  async readByJob(jobId: string): Promise<T[]> {
    const all = await this.readAll();
    return all
      .filter((row): row is T & { jobId?: string } => (row as { jobId?: string }).jobId === jobId)
      .reverse();
  }

  private async maybePrune(sampleRecord?: T): Promise<void> {
    if (!this.retentionMs && !this.maxRows) return;
    const now = Date.now();
    if (now - this.lastPruned < this.pruneIntervalMs) return;
    this.lastPruned = now;

    const all = await this.readAll();
    if (all.length === 0) return;

    const cutoff = this.retentionMs ? new Date(now - this.retentionMs) : null;

    const filtered = all
      .map((row) => ({ row, ts: this.extractTimestamp(row) }))
      .filter(({ ts }) => {
        if (!cutoff) return true;
        return ts ? ts >= cutoff.getTime() : false;
      })
      .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
      .map(({ row }) => row);

    const pruned = this.maxRows ? filtered.slice(-this.maxRows) : filtered;

    // Only rewrite when something changed
    if (pruned.length !== all.length) {
      const tmpPath = `${this.filepath}.${randomUUID()}.tmp`;
      const payload = pruned.map((r) => JSON.stringify(r)).join('\n') + '\n';
      await writeFile(tmpPath, payload, 'utf-8');
      await rename(tmpPath, this.filepath);
    }
  }

  private extractTimestamp(row: T): number | null {
    const candidate = (row as any).createdAt ?? (row as any).endedAt ?? (row as any).startedAt;
    const ts = candidate ? Date.parse(candidate as string) : NaN;
    return Number.isFinite(ts) ? ts : null;
  }
}
