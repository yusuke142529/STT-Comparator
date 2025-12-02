import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';

const PREVIEW_TTL_MS = 5 * 60 * 1000;

type PreviewItem = {
  id: string;
  filePath: string;
  createdAt: string;
  cleanupTimer: NodeJS.Timeout;
};

/**
 * Keeps track of temporary preview WAV files generated for browser-safe playback.
 * Files are auto-deleted after PREVIEW_TTL_MS to avoid disk bloat.
 */
export class PreviewStore {
  private items = new Map<string, PreviewItem>();

  create(filePath: string): PreviewItem {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const cleanupTimer = setTimeout(() => {
      void this.cleanup(id);
    }, PREVIEW_TTL_MS);

    const item: PreviewItem = { id, filePath, createdAt, cleanupTimer };
    this.items.set(id, item);
    return item;
  }

  take(id: string): PreviewItem | null {
    const item = this.items.get(id);
    if (!item) return null;
    clearTimeout(item.cleanupTimer);
    this.items.delete(id);
    return item;
  }

  async cleanup(id: string) {
    const item = this.items.get(id);
    if (!item) return;
    clearTimeout(item.cleanupTimer);
    await unlink(item.filePath).catch(() => undefined);
    this.items.delete(id);
  }
}
