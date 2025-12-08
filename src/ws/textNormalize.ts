/**
 * Text normalization utilities used by realtime normalization pipeline.
 * The goal is to make provider outputs comparable without destroying
 * information that might be useful for debugging.
 */

const SMART_QUOTES = /[“”„‟‹›«»]/g;

const stripPunctuation = (value: string): string => value.replace(/[、。.,!?！？]/g, '');

export interface NormalizedText {
  textNorm: string;
  punctuationApplied: boolean;
  casingApplied: boolean;
}

/**
 * Normalize transcript text according to a preset.
 * - Always applies NFKC, whitespace collapse, and trim.
 * - Presets:
 *   - "wer": lowercase + strip punctuation + collapse whitespace
 *   - "cer": keep case/punctuation, only base normalization
 *   - "nopunct": lowercase + strip punctuation (keeps spaces)
 */
export function normalizeText(text: string, preset?: string): NormalizedText {
  const base = text
    // unify smart quotes so visual diffs are easier to read
    .replace(SMART_QUOTES, '"')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();

  const punctuationApplied = /[、。.,!?！？]/.test(base);
  const casingApplied = /[A-Z]/.test(base);

  const lower = base.toLowerCase();

  if (!preset) {
    return { textNorm: base, punctuationApplied, casingApplied };
  }

  const normalizedPreset = preset.toLowerCase();

  if (normalizedPreset.includes('wer')) {
    const textNorm = stripPunctuation(lower).replace(/\s+/g, ' ').trim();
    return { textNorm, punctuationApplied, casingApplied };
  }

  if (normalizedPreset.includes('nopunct')) {
    const textNorm = stripPunctuation(lower).trim();
    return { textNorm, punctuationApplied, casingApplied };
  }

  // CER or unknown preset falls back to baseline normalization
  return { textNorm: base, punctuationApplied, casingApplied };
}
