import { describe, expect, it } from 'vitest';
import { StreamNormalizer } from './streamNormalizer.js';
import type { ProviderId } from '../types.js';

describe('StreamNormalizer', () => {
  const provider = 'deepgram' as ProviderId;

  it('buckets transcripts by window and increments revision', () => {
    const normalizer = new StreamNormalizer({ bucketMs: 250, sessionId: 'test-session', preset: undefined });
    const first = normalizer.ingest(provider, {
      provider,
      isFinal: false,
      text: 'hello',
      timestamp: 1000,
      originCaptureTs: 1000,
      channel: 'mic',
    });
    expect(first.windowId).toBe(Math.floor(1000 / 250));
    expect(first.revision).toBe(1);
    expect(first.textNorm).toBe('hello');

    const second = normalizer.ingest(provider, {
      provider,
      isFinal: true,
      text: 'hello world',
      timestamp: 1020,
      originCaptureTs: 1020,
      channel: 'mic',
    });
    expect(second.windowId).toBe(first.windowId);
    expect(second.revision).toBe(2);
    expect(second.isFinal).toBe(true);
    expect(second.textNorm).toBe('world');
  });

  it('applies preset normalization consistently', () => {
    const normalizer = new StreamNormalizer({ bucketMs: 100, sessionId: 's', preset: 'wer' });
    const event = normalizer.ingest(provider, {
      provider,
      isFinal: false,
      text: 'Hello, World! ',
      timestamp: 500,
      channel: 'mic',
    });
    expect(event.textNorm).toBe('hello world');
    expect(event.punctuationApplied).toBe(true);
    expect(event.casingApplied).toBe(true);
  });

  it('ignores interim updates after a final to avoid churn', () => {
    const normalizer = new StreamNormalizer({ bucketMs: 200, sessionId: 's2', preset: undefined });
    const final = normalizer.ingest(provider, {
      provider,
      isFinal: true,
      text: 'done',
      timestamp: 1000,
      channel: 'mic',
    });
    expect(final.isFinal).toBe(true);
    expect(final.revision).toBe(1);

    const interim = normalizer.ingest(provider, {
      provider,
      isFinal: false,
      text: 'should be ignored',
      timestamp: 1020,
      channel: 'mic',
    });

    expect(interim.isFinal).toBe(true);
    expect(interim.revision).toBe(1);
    expect(interim.textNorm).toBe('done');
  });

  it('builds stable normalizedId per session/provider/window/revision', () => {
    const normalizer = new StreamNormalizer({ bucketMs: 250, sessionId: 'sess-123', preset: undefined });
    const first = normalizer.ingest(provider, {
      provider,
      isFinal: false,
      text: 'a',
      timestamp: 0,
      channel: 'mic',
    });
    const second = normalizer.ingest(provider, {
      provider,
      isFinal: true,
      text: 'ab',
      timestamp: 10,
      channel: 'mic',
    });

    expect(first.normalizedId).toBe('sess-123:deepgram:0:1');
    expect(second.normalizedId).toBe('sess-123:deepgram:0:2');
  });
});
