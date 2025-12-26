import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, reloadConfig } from './config.js';

const formatLocalDate = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

describe('loadConfig', () => {
  let tempDir: string | null = null;

  beforeEach(() => {
    reloadConfig();
  });

  afterEach(async () => {
    reloadConfig();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('expands {date} in storage.path', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'stt-config-'));
    const configPath = path.join(tempDir, 'config.json');
    const payload = {
      audio: { targetSampleRate: 16000, targetChannels: 1, chunkMs: 250 },
      normalization: { nfkc: true, stripPunct: true, stripSpace: false, lowercase: false },
      storage: { driver: 'jsonl', path: './runs/{date}', retentionDays: 30, maxRows: 100000 },
      providers: ['mock'],
    };
    await writeFile(configPath, JSON.stringify(payload), 'utf-8');

    const config = await loadConfig(configPath);
    expect(config.storage.path).toBe(`./runs/${formatLocalDate()}`);
  });
});
