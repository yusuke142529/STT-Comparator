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
  normalization: z
    .object({
      nfkc: z.boolean().optional(),
      stripPunct: z.boolean().optional(),
      stripSpace: z.boolean().optional(),
      lowercase: z.boolean().optional(),
  })
  .optional(),
});

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

  return manifest.items.find((item) => {
    const itemBase = path.posix.basename(normalizeAudioPath(item.audio) || item.audio);
    return itemBase === filenameBase;
  });
}
