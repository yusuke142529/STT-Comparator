import { describe, expect, it } from 'vitest';
import type { EvaluationManifest } from '../types.js';
import { matchManifestItem } from './manifest.js';

const manifest: EvaluationManifest = {
  version: 1,
  language: 'ja-JP',
  items: [
    { audio: 'samples/dirA/one.wav', ref: 'first' },
    { audio: 'samples/dirB/one.wav', ref: 'second' },
    { audio: 'simple.wav', ref: 'simple' },
  ],
};

describe('matchManifestItem', () => {
  it('matches when upload path and manifest path normalize exactly', () => {
    const item = matchManifestItem(manifest, 'samples/dirA/one.wav');
    expect(item?.ref).toBe('first');
  });

  it('matches windows-style separators by normalizing them first', () => {
    const item = matchManifestItem(manifest, 'samples\\dirB\\one.wav');
    expect(item?.ref).toBe('second');
  });

  it('falls back to basename when normalized paths are identical but no directory info provided', () => {
    const item = matchManifestItem({ ...manifest, allowBasenameFallback: true }, 'simple.wav');
    expect(item?.ref).toBe('simple');
  });

  it('returns undefined when there is no basename match', () => {
    expect(matchManifestItem(manifest, 'missing.wav')).toBeUndefined();
  });
});
