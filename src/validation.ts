import { z } from 'zod';

export const transcriptionOptionsSchema = z
  .object({
    enableVad: z.boolean().optional(),
    punctuationPolicy: z.enum(['none', 'basic', 'full']).optional(),
    dictionaryPhrases: z.array(z.string()).max(100).optional(),
    parallel: z.number().int().min(1).max(16).optional(),
  })
  .partial();

export const streamingConfigMessageSchema = z
  .object({
    type: z.literal('config'),
    enableInterim: z.boolean().optional(),
    contextPhrases: z.array(z.string()).max(100).optional(),
    normalizePreset: z.string().max(100).optional(),
    pcm: z.boolean().optional(),
    degraded: z.boolean().optional(),
    options: transcriptionOptionsSchema.optional(),
  })
  .strict();
