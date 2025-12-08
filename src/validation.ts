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
    // Optional sample rate hint from the client AudioContext. Allows the server
    // to avoid assuming 16 kHz when the browser/hardware forces a different
    // rate (common on some Windows devices).
    clientSampleRate: z.number().int().min(8_000).max(96_000).optional(),
    options: transcriptionOptionsSchema.optional(),
  })
  .strict()
  // When raw PCM is sent (pcm: true) we need the originating sample rate to resample accurately.
  // Enforce presence here to avoid silent format mismatches on the provider side.
  .superRefine((val, ctx) => {
    if (val.pcm && (val.clientSampleRate === undefined || val.clientSampleRate === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'clientSampleRate is required when pcm=true',
        path: ['clientSampleRate'],
      });
    }
  });
