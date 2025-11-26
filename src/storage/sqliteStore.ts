import Database from 'better-sqlite3';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { BatchJobFileResult, StorageDriver } from '../types.js';
import type { RetentionPolicy } from './retention.js';

export class SqliteStore implements StorageDriver<BatchJobFileResult> {
  private db: Database.Database | null = null;
  private readonly retentionMs: number | undefined;
  private readonly maxRows: number | undefined;
  private readonly pruneIntervalMs: number;
  private lastPruned = 0;

  constructor(
    private readonly dbPath: string,
    existingDb?: Database.Database,
    retention?: RetentionPolicy
  ) {
    this.db = existingDb ?? null;
    this.retentionMs = retention?.retentionMs;
    this.maxRows = retention?.maxRows;
    this.pruneIntervalMs = retention?.pruneIntervalMs ?? 5 * 60 * 1000;
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.dbPath), { recursive: true });
    if (!this.db) {
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('busy_timeout = 1000');
    }
    this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS results (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          jobId TEXT,
          path TEXT,
          provider TEXT,
          lang TEXT,
          durationSec REAL,
          processingTimeMs INTEGER,
          rtf REAL,
          cer REAL,
          wer REAL,
          latencyMs INTEGER,
          vendorProcessingMs INTEGER,
          text TEXT,
          refText TEXT,
          opts TEXT,
          createdAt TEXT
        )`
      )
      .run();

    // simple migration: add jobId if missing
    const jobColumns = this.db.prepare(`PRAGMA table_info('results')`).all() as Database.ColumnDefinition[];
    const hasJobId = jobColumns.some((row) => row.name === 'jobId');
    if (!hasJobId) {
      this.db.prepare(`ALTER TABLE results ADD COLUMN jobId TEXT`).run();
    }
    const hasVendorProcessing = jobColumns.some((row) => row.name === 'vendorProcessingMs');
    if (!hasVendorProcessing) {
      this.db.prepare(`ALTER TABLE results ADD COLUMN vendorProcessingMs INTEGER`).run();
    }

    const createdAtColumns = this.db.prepare(`PRAGMA table_info('results')`).all() as Database.ColumnDefinition[];
    const hasCreatedAt = createdAtColumns.some((row) => row.name === 'createdAt');
    if (!hasCreatedAt) {
      this.db.prepare(`ALTER TABLE results ADD COLUMN createdAt TEXT`).run();
      this.db.prepare(`UPDATE results SET createdAt = datetime('now') WHERE createdAt IS NULL`).run();
    }
  }

  async append(record: BatchJobFileResult): Promise<void> {
    if (!this.db) throw new Error('SQLite store not initialized');
    this.db
      .prepare(
        `INSERT INTO results (jobId, path, provider, lang, durationSec, processingTimeMs, rtf, cer, wer, latencyMs, vendorProcessingMs, text, refText, opts, createdAt)
         VALUES (@jobId, @path, @provider, @lang, @durationSec, @processingTimeMs, @rtf, @cer, @wer, @latencyMs, @vendorProcessingMs, @text, @refText, @opts, @createdAt)`
      )
      .run({
        ...record,
        opts: record.opts ? JSON.stringify(record.opts) : null,
        createdAt: record.createdAt ?? new Date().toISOString(),
      });

    await this.maybePrune();
  }

  async readAll(): Promise<BatchJobFileResult[]> {
    if (!this.db) throw new Error('SQLite store not initialized');
    const rows = this.db.prepare('SELECT * FROM results ORDER BY id DESC').all() as (BatchJobFileResult & { opts: string | null })[];
    return rows.map((row) => ({
      ...row,
      opts: row.opts ? (JSON.parse(row.opts) as Record<string, unknown>) : undefined,
    }));
  }

  async readRecent(limit: number): Promise<BatchJobFileResult[]> {
    if (!this.db) throw new Error('SQLite store not initialized');
    const rows = this.db
      .prepare('SELECT * FROM results ORDER BY id DESC LIMIT ?')
      .all(limit) as (BatchJobFileResult & { opts: string | null })[];
    return rows.map((row) => ({
      ...row,
      opts: row.opts ? (JSON.parse(row.opts) as Record<string, unknown>) : undefined,
    }));
  }

  async readByJob(jobId: string): Promise<BatchJobFileResult[]> {
    if (!this.db) throw new Error('SQLite store not initialized');
    const rows = this.db
      .prepare('SELECT * FROM results WHERE jobId = ? ORDER BY id DESC')
      .all(jobId) as (BatchJobFileResult & { opts: string | null })[];
    return rows.map((row) => ({
      ...row,
      opts: row.opts ? (JSON.parse(row.opts) as Record<string, unknown>) : undefined,
    }));
  }

  private async maybePrune(): Promise<void> {
    if (!this.db) throw new Error('SQLite store not initialized');
    if (!this.retentionMs && !this.maxRows) return;
    const now = Date.now();
    if (now - this.lastPruned < this.pruneIntervalMs) return;
    this.lastPruned = now;

    const trx = this.db.transaction(() => {
      if (this.retentionMs) {
        const cutoffIso = new Date(now - this.retentionMs).toISOString();
        this.db!
          .prepare(`DELETE FROM results WHERE createdAt IS NOT NULL AND createdAt < ?`)
          .run(cutoffIso);
      }
      if (this.maxRows) {
        this.db!
          .prepare(
            `DELETE FROM results WHERE id NOT IN (SELECT id FROM results ORDER BY id DESC LIMIT ?)`
          )
          .run(this.maxRows);
      }
    });
    trx();
  }
}
