import type { NormalizationConfig } from '../types.js';

const defaultConfig: NormalizationConfig = {
  nfkc: true,
  stripPunct: true,
  stripSpace: false,
  lowercase: false,
};

const punctRegex = /[\p{P}\p{S}]/gu;
const spaceRegex = /\s+/g;

export function normalizeText(text: string, config?: NormalizationConfig): string {
  const settings = { ...defaultConfig, ...config };
  let output = text;

  if (settings.nfkc) {
    output = output.normalize('NFKC');
  }
  if (settings.lowercase) {
    output = output.toLowerCase();
  }
  if (settings.stripPunct) {
    output = output.replace(punctRegex, '');
  }
  if (settings.stripSpace) {
    output = output.replace(spaceRegex, '');
  }
  return output.trim();
}
