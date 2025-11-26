import path from 'node:path';
import Database from 'better-sqlite3';
import { JsonlStore } from './jsonlStore.js';
import { SqliteStore } from './sqliteStore.js';
import { RealtimeSqliteStore } from './realtimeSqliteStore.js';
import { RealtimeTranscriptStore } from './realtimeTranscriptStore.js';
import type { StorageDriver, StorageDriverName, BatchJobFileResult, RealtimeLatencySummary } from '../types.js';
import type { RetentionPolicy } from './retention.js';

let sharedDb: { path: string; db: Database.Database } | null = null;

function getOrCreateDatabase(dbPath: string): Database.Database {
  if (sharedDb && sharedDb.path === dbPath) {
    return sharedDb.db;
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 1000');
  sharedDb = { path: dbPath, db };
  return db;
}

export function createStorage(
  driver: StorageDriverName,
  storagePath: string,
  retention?: RetentionPolicy
): StorageDriver<BatchJobFileResult> {
  if (driver === 'jsonl') {
    return new JsonlStore<BatchJobFileResult>(path.resolve(storagePath, 'results.jsonl'), retention);
  }
  const dbPath = path.resolve(storagePath, 'results.sqlite');
  return new SqliteStore(dbPath, getOrCreateDatabase(dbPath), retention);
}

export function createRealtimeStorage(
  driver: StorageDriverName,
  storagePath: string,
  retention?: RetentionPolicy
): StorageDriver<RealtimeLatencySummary> {
  if (driver === 'jsonl') {
    return new JsonlStore<RealtimeLatencySummary>(
      path.resolve(storagePath, 'realtime.jsonl'),
      retention
    );
  }
  const dbPath = path.resolve(storagePath, 'results.sqlite');
  return new RealtimeSqliteStore(dbPath, getOrCreateDatabase(dbPath), retention);
}

export function createRealtimeTranscriptStore(
  storagePath: string,
  retention?: RetentionPolicy
): RealtimeTranscriptStore {
  const filePath = path.resolve(storagePath, 'realtime-logs.jsonl');
  return new RealtimeTranscriptStore(filePath, retention);
}
