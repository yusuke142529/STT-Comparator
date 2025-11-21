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

export function parseManifest(json: string): EvaluationManifest {
  return manifestSchema.parse(JSON.parse(json));
}

export function matchManifestItem(manifest: EvaluationManifest, filename: string) {
  const base = path.basename(filename);
  return manifest.items.find((item) => path.basename(item.audio) === base);
}
