import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RealtimeTranscriptStore } from './realtimeTranscriptStore.js';
import type { RealtimeTranscriptLogEntry } from '../types.js';

describe('RealtimeTranscriptStore', () => {
  let tempDir: string;
  let store: RealtimeTranscriptStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'stt-realtime-log-'));
    store = new RealtimeTranscriptStore(path.join(tempDir, 'logs.jsonl'));
    await store.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('persists and reads per-session log entries', async () => {
    const sessionId = 'session-abc';
    const baseTime = new Date().toISOString();
    const sessionEntry: RealtimeTranscriptLogEntry = {
      sessionId,
      provider: 'mock',
      lang: 'ja-JP',
      recordedAt: baseTime,
      payload: {
        type: 'session',
        sessionId,
        provider: 'mock',
        startedAt: baseTime,
      },
    };
    const transcriptEntry: RealtimeTranscriptLogEntry = {
      sessionId,
      provider: 'mock',
      lang: 'ja-JP',
      recordedAt: new Date().toISOString(),
      payload: {
        type: 'transcript',
        provider: 'mock',
        isFinal: true,
        text: 'hello',
        timestamp: 123,
        channel: 'mic',
      },
    };

    await store.append(sessionEntry);
    await store.append(transcriptEntry);

    const entries = await store.readSession(sessionId);
    expect(entries).toEqual([sessionEntry, transcriptEntry]);

    const missing = await store.readSession('unknown');
    expect(missing).toEqual([]);
  });
});
