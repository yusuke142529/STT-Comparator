import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import type { Express } from 'express';
import type { ProviderId } from '../types.js';

const SESSION_TTL_MS = 5 * 60 * 1000;

type StoredSession = {
  id: string;
  filePath: string;
  originalName: string;
  provider: ProviderId;
  lang: string;
  createdAt: string;
  used: boolean;
  cleanupTimer: NodeJS.Timeout;
};

export class ReplaySessionStore {
  private sessions = new Map<string, StoredSession>();

  create(file: Express.Multer.File, provider: ProviderId, lang: string) {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const timer = setTimeout(() => {
      void this.cleanup(id);
    }, SESSION_TTL_MS);

    const stored: StoredSession = {
      id,
      filePath: file.path,
      originalName: file.originalname,
      provider,
      lang,
      createdAt,
      used: false,
      cleanupTimer: timer,
    };

    this.sessions.set(id, stored);
    return stored;
  }

  take(id: string) {
    const session = this.sessions.get(id);
    if (!session || session.used) return null;
    session.used = true;
    clearTimeout(session.cleanupTimer);
    return session;
  }

  async cleanup(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    clearTimeout(session.cleanupTimer);
    await unlink(session.filePath).catch(() => undefined);
    this.sessions.delete(id);
  }
}
