import path from 'node:path';
import { z } from 'zod';
import type { EvaluationManifest } from '../types.js';

const manifestSchema = z.object({
  version: z.number().min(1),
  language: z.string(),
  items: z.array(
    z.object({
      audio: z.string(),
      ref: z.string(),
      meta: z.record(z.unknown()).optional(),
    })
  ),
  allowBasenameFallback: z.boolean().optional(),
  normalization: z
    .object({
      nfkc: z.boolean().optional(),
      stripPunct: z.boolean().optional(),
      stripSpace: z.boolean().optional(),
      lowercase: z.boolean().optional(),
  })
  .optional(),
});

export class ManifestMatchError extends Error {
  code: 'MANIFEST_AMBIGUOUS';

  constructor(message: string) {
    super(message);
    this.code = 'MANIFEST_AMBIGUOUS';
  }
}

function normalizeAudioPath(value: string): string {
  const raw = value.replace(/\\/g, '/');
  const normalized = path.posix.normalize(raw);
  const trimmed = normalized.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  return trimmed === '.' ? '' : trimmed;
}

export function parseManifest(json: string): EvaluationManifest {
  return manifestSchema.parse(JSON.parse(json));
}

export function matchManifestItem(manifest: EvaluationManifest, filename: string) {
  const normalizedFilename = normalizeAudioPath(filename);
  const filenameBase = path.posix.basename(normalizedFilename || filename);

  const exactMatch = manifest.items.find(
    (item) => normalizeAudioPath(item.audio) === normalizedFilename
  );
  if (exactMatch) {
    return exactMatch;
  }

  if (manifest.allowBasenameFallback !== true) {
    return undefined;
  }

  const basenameMatches = manifest.items.filter((item) => {
    const itemBase = path.posix.basename(normalizeAudioPath(item.audio) || item.audio);
    return itemBase === filenameBase;
  });

  if (basenameMatches.length > 1) {
    throw new ManifestMatchError(
      `ambiguous manifest match for "${filenameBase}" (${basenameMatches.length} candidates)`
    );
  }

  return basenameMatches[0];
}
