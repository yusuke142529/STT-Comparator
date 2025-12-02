import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { PROVIDER_IDS } from './types.js';
import type { AppConfig, ProviderId } from './types.js';

const normalizationSchema = z.object({
  nfkc: z.boolean().optional(),
  stripPunct: z.boolean().optional(),
  stripSpace: z.boolean().optional(),
  lowercase: z.boolean().optional(),
});

const ingressNormalizeSchema = z
  .object({
    enabled: z.boolean().optional(),
    targetSampleRate: z.number().optional(),
    targetChannels: z.number().optional(),
    peakDbfs: z.number().optional(),
    maxDurationSec: z.number().min(0.1).max(3600).optional(),
  })
  .partial()
  .default({});

const configSchema = z.object({
  audio: z.object({
    targetSampleRate: z.number().default(16000),
    targetChannels: z.number().default(1),
    chunkMs: z.number().default(250),
  }),
  ingressNormalize: ingressNormalizeSchema.optional(),
  normalization: normalizationSchema,
  storage: z.object({
    driver: z.enum(['jsonl', 'sqlite']),
    path: z.string().default('./runs/latest'),
    retentionDays: z.number().min(1).max(3650).default(30),
    maxRows: z.number().min(100).max(1_000_000).default(100_000),
  }),
  providers: z.array(z.enum(PROVIDER_IDS)),
  jobs: z
    .object({
      maxParallel: z.number().min(1).max(64).default(4),
      retentionMs: z.number().min(0).default(10 * 60 * 1000),
    })
    .partial()
    .default({}),
  ws: z
    .object({
      maxPcmQueueBytes: z.number().min(128 * 1024).max(100 * 1024 * 1024).default(5 * 1024 * 1024),
    })
    .partial()
    .default({}),
  providerHealth: z
    .object({
      refreshMs: z.number().int().min(1).optional(),
    })
    .default({}),
});

let cachedConfig: AppConfig | null = null;

export async function loadConfig(configPath = path.resolve('config.json')): Promise<AppConfig> {
  if (cachedConfig) {
    return cachedConfig;
  }

  const raw = await readFile(configPath, 'utf-8');
  const parsed = configSchema.parse(JSON.parse(raw));
  const typed: AppConfig = {
    ...parsed,
    providers: parsed.providers as ProviderId[],
  };
  cachedConfig = typed;
  return typed;
}

export function reloadConfig(): void {
  cachedConfig = null;
}
