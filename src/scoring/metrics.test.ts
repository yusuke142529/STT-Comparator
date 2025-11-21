import { describe, expect, test } from 'vitest';
import { cer, wer, rtf } from './metrics.js';

describe('metrics', () => {
  test('cer zero for identical text', () => {
    expect(cer('テスト', 'テスト')).toBe(0);
  });

  test('wer handles whitespace and case', () => {
    expect(wer('Hello world', 'hello  world', { lowercase: true })).toBe(0);
  });

  test('rtf divides processing time by duration', () => {
    expect(rtf(5000, 10)).toBe(0.5);
  });
});
