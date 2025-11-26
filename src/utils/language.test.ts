import { describe, expect, it } from 'vitest';
import { normalizeIsoLanguageCode, normalizeWhisperLanguage } from './language.js';

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

describe('normalizeIsoLanguageCode', () => {
  it('normalizes the primary ISO code', () => {
    expect(normalizeIsoLanguageCode('EN')).toBe('en');
    expect(normalizeIsoLanguageCode('fr-CA')).toBe('fr');
    expect(normalizeIsoLanguageCode('zho')).toBe('zho');
    expect(normalizeIsoLanguageCode('ZH-CN')).toBe('zh');
  });

  it('returns undefined for invalid or unsupported values', () => {
    expect(normalizeIsoLanguageCode('english')).toBeUndefined();
    expect(normalizeIsoLanguageCode('')).toBeUndefined();
    expect(normalizeIsoLanguageCode('   ')).toBeUndefined();
    expect(normalizeIsoLanguageCode('1a')).toBeUndefined();
    expect(normalizeIsoLanguageCode('abcd')).toBeUndefined();
  });
});
