import Database from 'better-sqlite3';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { RealtimeTranscriptLogEntry, RealtimeTranscriptSessionSummary } from '../types.js';
import type { RetentionPolicy } from './retention.js';
import type { RealtimeTranscriptLogStore } from './realtimeTranscriptStore.js';

type SessionKey = `${string}:${string}`;

export class RealtimeTranscriptSqliteStore implements RealtimeTranscriptLogStore {
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
        `CREATE TABLE IF NOT EXISTS realtime_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sessionId TEXT,
          provider TEXT,
          lang TEXT,
          recordedAt TEXT,
          payload TEXT,
          speakerId TEXT
        )`
      )
      .run();

    const columns = this.db.prepare(`PRAGMA table_info('realtime_logs')`).all() as Database.ColumnDefinition[];
    const hasSpeakerId = columns.some((row) => row.name === 'speakerId');
    if (!hasSpeakerId) {
      this.db.prepare(`ALTER TABLE realtime_logs ADD COLUMN speakerId TEXT`).run();
    }

    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_realtime_logs_session ON realtime_logs(sessionId)`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_realtime_logs_recorded ON realtime_logs(recordedAt)`).run();
  }

  async append(entry: RealtimeTranscriptLogEntry): Promise<void> {
    if (!this.db) throw new Error('SQLite realtime transcript store not initialized');
    const speakerId =
      entry.payload.type === 'transcript' || entry.payload.type === 'normalized'
        ? entry.payload.speakerId ?? null
        : null;
    this.db
      .prepare(
        `INSERT INTO realtime_logs (sessionId, provider, lang, recordedAt, payload, speakerId)
         VALUES (@sessionId, @provider, @lang, @recordedAt, @payload, @speakerId)`
      )
      .run({
        sessionId: entry.sessionId,
        provider: entry.provider,
        lang: entry.lang,
        recordedAt: entry.recordedAt,
        payload: JSON.stringify(entry.payload),
        speakerId,
      });

    await this.maybePrune();
  }

  async readSession(sessionId: string): Promise<RealtimeTranscriptLogEntry[]> {
    if (!this.db) throw new Error('SQLite realtime transcript store not initialized');
    const rows = this.db
      .prepare(
        `SELECT sessionId, provider, lang, recordedAt, payload
         FROM realtime_logs
         WHERE sessionId = ?
         ORDER BY id ASC`
      )
      .all(sessionId) as Array<Omit<RealtimeTranscriptLogEntry, 'payload'> & { payload: string }>;

    return rows.map((row) => ({
      ...row,
      payload: JSON.parse(row.payload) as RealtimeTranscriptLogEntry['payload'],
    }));
  }

  async listSessions(limit = 20): Promise<RealtimeTranscriptSessionSummary[]> {
    if (!this.db) throw new Error('SQLite realtime transcript store not initialized');
    const rows = this.db
      .prepare(
        `SELECT sessionId, provider, lang, MIN(recordedAt) as startedAt, MAX(recordedAt) as lastRecordedAt, COUNT(*) as entryCount
         FROM realtime_logs
         GROUP BY sessionId, provider, lang
         ORDER BY lastRecordedAt DESC
         LIMIT ?`
      )
      .all(Math.max(1, Math.min(50, limit))) as Array<RealtimeTranscriptSessionSummary & { startedAt: string | null }>;

    return rows.map((row) => ({
      sessionId: row.sessionId,
      provider: row.provider,
      lang: row.lang,
      startedAt: row.startedAt,
      lastRecordedAt: row.lastRecordedAt,
      entryCount: row.entryCount,
    }));
  }

  private async maybePrune(): Promise<void> {
    if (!this.db) throw new Error('SQLite realtime transcript store not initialized');
    if (!this.retentionMs && !this.maxRows) return;
    const now = Date.now();
    if (now - this.lastPruned < this.pruneIntervalMs) return;
    this.lastPruned = now;

    const trx = this.db.transaction(() => {
      if (this.retentionMs) {
        const cutoffIso = new Date(now - this.retentionMs).toISOString();
        this.db!.prepare(`DELETE FROM realtime_logs WHERE recordedAt < ?`).run(cutoffIso);
      }
      if (this.maxRows) {
        this.db!
          .prepare(
            `DELETE FROM realtime_logs WHERE id NOT IN (
              SELECT id FROM realtime_logs ORDER BY id DESC LIMIT ?
            )`
          )
          .run(this.maxRows);
      }
    });
    trx();
  }
}
