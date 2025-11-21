import Database from 'better-sqlite3';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { RealtimeLatencySummary, StorageDriver } from '../types.js';
import type { RetentionPolicy } from './retention.js';

export class RealtimeSqliteStore implements StorageDriver<RealtimeLatencySummary> {
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
        `CREATE TABLE IF NOT EXISTS realtime_latency (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sessionId TEXT,
          provider TEXT,
          lang TEXT,
          count INTEGER,
          avg REAL,
          p50 REAL,
          p95 REAL,
          min REAL,
          max REAL,
          startedAt TEXT,
          endedAt TEXT
        )`
      )
      .run();
  }

  async append(record: RealtimeLatencySummary): Promise<void> {
    if (!this.db) throw new Error('SQLite realtime store not initialized');
    this.db
      .prepare(
        `INSERT INTO realtime_latency (sessionId, provider, lang, count, avg, p50, p95, min, max, startedAt, endedAt)
         VALUES (@sessionId, @provider, @lang, @count, @avg, @p50, @p95, @min, @max, @startedAt, @endedAt)`
      )
      .run(record);

    await this.maybePrune();
  }

  async readAll(): Promise<RealtimeLatencySummary[]> {
    if (!this.db) throw new Error('SQLite realtime store not initialized');
    const rows = this.db.prepare('SELECT * FROM realtime_latency ORDER BY id DESC').all() as RealtimeLatencySummary[];
    return rows;
  }

  async readRecent(limit: number): Promise<RealtimeLatencySummary[]> {
    if (!this.db) throw new Error('SQLite realtime store not initialized');
    const rows = this.db
      .prepare('SELECT * FROM realtime_latency ORDER BY id DESC LIMIT ?')
      .all(limit) as RealtimeLatencySummary[];
    return rows;
  }

  private async maybePrune(): Promise<void> {
    if (!this.db) throw new Error('SQLite realtime store not initialized');
    if (!this.retentionMs && !this.maxRows) return;
    const now = Date.now();
    if (now - this.lastPruned < this.pruneIntervalMs) return;
    this.lastPruned = now;

    const trx = this.db.transaction(() => {
      if (this.retentionMs) {
        const cutoffIso = new Date(now - this.retentionMs).toISOString();
        this.db!.prepare(`DELETE FROM realtime_latency WHERE endedAt < ?`).run(cutoffIso);
      }
      if (this.maxRows) {
        this.db!
          .prepare(
            `DELETE FROM realtime_latency WHERE id NOT IN (SELECT id FROM realtime_latency ORDER BY id DESC LIMIT ?)`
          )
          .run(this.maxRows);
      }
    });
    trx();
  }
}
