import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { JsonlStore } from './jsonlStore.js';

describe('JsonlStore pruning', () => {
  it('drops records older than retention and caps maxRows', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'jsonl-prune-'));
    const store = new JsonlStore<any>(path.join(dir, 'test.jsonl'), {
      retentionMs: 5_000,
      maxRows: 2,
      pruneIntervalMs: 0,
    });

    await store.init();

    await store.append({ id: 'old', createdAt: new Date(Date.now() - 10_000).toISOString() });
    await store.append({ id: 'mid', createdAt: new Date().toISOString() });
    await store.append({ id: 'new', createdAt: new Date().toISOString() });

    const rows = await store.readAll();
    const ids = rows.map((r: any) => r.id);
    expect(ids).toEqual(['mid', 'new']);

    await rm(dir, { recursive: true, force: true });
  });

  it('uses recordedAt when present for retention', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'jsonl-prune-recorded-'));
    const store = new JsonlStore<any>(path.join(dir, 'test.jsonl'), {
      retentionMs: 5_000,
      pruneIntervalMs: 0,
    });

    await store.init();

    await store.append({ id: 'old', recordedAt: new Date(Date.now() - 10_000).toISOString() });
    await store.append({ id: 'new', recordedAt: new Date().toISOString() });

    const rows = await store.readAll();
    const ids = rows.map((r: any) => r.id);
    expect(ids).toEqual(['new']);

    await rm(dir, { recursive: true, force: true });
  });
});
