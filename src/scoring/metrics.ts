import { normalizeText } from './normalize.js';
import type { NormalizationConfig } from '../types.js';

function levenshtein(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]) + 1;
      }
    }
  }
  return dp[a.length][b.length];
}

export function cer(ref: string, hyp: string, config?: NormalizationConfig): number {
  const refChars = normalizeText(ref, config).split('');
  const hypChars = normalizeText(hyp, config).split('');
  if (refChars.length === 0) return hypChars.length === 0 ? 0 : 1;
  const dist = levenshtein(refChars, hypChars);
  return dist / refChars.length;
}

export function wer(ref: string, hyp: string, config?: NormalizationConfig): number {
  const refWords = normalizeText(ref, config).split(/\s+/).filter(Boolean);
  const hypWords = normalizeText(hyp, config).split(/\s+/).filter(Boolean);
  if (refWords.length === 0) return hypWords.length === 0 ? 0 : 1;
  const dist = levenshtein(refWords, hypWords);
  return dist / refWords.length;
}

export function rtf(processingTimeMs: number, durationSec: number): number {
  if (durationSec === 0) return 0;
  return (processingTimeMs / 1000) / durationSec;
}
