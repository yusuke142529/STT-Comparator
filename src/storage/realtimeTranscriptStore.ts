import { JsonlStore } from './jsonlStore.js';
import type { RetentionPolicy } from './retention.js';
import type { RealtimeTranscriptLogEntry, RealtimeTranscriptSessionSummary } from '../types.js';

export interface RealtimeTranscriptLogWriter {
  append(entry: RealtimeTranscriptLogEntry): Promise<void>;
}

export class RealtimeTranscriptStore implements RealtimeTranscriptLogWriter {
  private readonly store: JsonlStore<RealtimeTranscriptLogEntry>;

  constructor(filepath: string, retention?: RetentionPolicy) {
    this.store = new JsonlStore<RealtimeTranscriptLogEntry>(filepath, retention);
  }

  async init(): Promise<void> {
    await this.store.init();
  }

  async append(entry: RealtimeTranscriptLogEntry): Promise<void> {
    await this.store.append(entry);
  }

  async readSession(sessionId: string): Promise<RealtimeTranscriptLogEntry[]> {
    const all = await this.store.readAll();
    return all.filter((entry) => entry.sessionId === sessionId);
  }

  async listSessions(limit = 20): Promise<RealtimeTranscriptSessionSummary[]> {
    const all = await this.store.readAll();
    const sessions = new Map<string, RealtimeTranscriptSessionSummary>();
    const parseTime = (value: string) => {
      const ts = Date.parse(value);
      return Number.isFinite(ts) ? ts : 0;
    };
    for (const entry of all) {
      const key = `${entry.sessionId}:${entry.provider}`;
      if (!sessions.has(key)) {
        sessions.set(key, {
          sessionId: entry.sessionId,
          provider: entry.provider,
          lang: entry.lang,
          startedAt: null,
          lastRecordedAt: entry.recordedAt,
          entryCount: 0,
        });
      }
      const meta = sessions.get(key)!;
      if (entry.payload.type === 'session' && typeof entry.payload.startedAt === 'string') {
        meta.startedAt = entry.payload.startedAt;
      }
      if (parseTime(entry.recordedAt) > parseTime(meta.lastRecordedAt)) {
        meta.lastRecordedAt = entry.recordedAt;
      }
      meta.entryCount += 1;
    }
    return Array.from(sessions.values())
      .sort((a, b) => parseTime(b.lastRecordedAt) - parseTime(a.lastRecordedAt))
      .slice(0, Math.max(1, Math.min(50, limit)));
  }
}
