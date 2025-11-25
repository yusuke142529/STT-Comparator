import { describe, expect, it } from 'vitest';
import { normalizeWhisperLanguage } from './language.js';

describe('normalizeWhisperLanguage', () => {
  it('returns the same code when supported', () => {
    expect(normalizeWhisperLanguage('ja')).toBe('ja');
    expect(normalizeWhisperLanguage('EN')).toBe('en');
  });

  it('falls back to the primary subtag for region variants', () => {
    expect(normalizeWhisperLanguage('ja-JP')).toBe('ja');
    expect(normalizeWhisperLanguage('en_US')).toBe('en');
    expect(normalizeWhisperLanguage('ZH-cn')).toBe('zh');
  });

  it('handles whitespace and casing', () => {
    expect(normalizeWhisperLanguage('  pt-BR  ')).toBe('pt');
  });

  it('returns undefined for unsupported codes', () => {
    expect(normalizeWhisperLanguage('unsupported')).toBeUndefined();
    expect(normalizeWhisperLanguage('')).toBeUndefined();
    expect(normalizeWhisperLanguage('   ')).toBeUndefined();
  });
});
