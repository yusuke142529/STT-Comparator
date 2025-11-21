import { createServer } from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import multer from 'multer';
import dotenv from 'dotenv';
import { WebSocketServer } from 'ws';
import { handleStreamConnection } from './ws/streamHandler.js';
import { logger } from './logger.js';
import { createRealtimeStorage, createStorage } from './storage/index.js';
import { loadConfig, reloadConfig } from './config.js';
import { BatchRunner } from './jobs/batchRunner.js';
import { parseManifest } from './utils/manifest.js';
import { toCsv } from './storage/csvExporter.js';
import { summarizeJob } from './utils/summary.js';
import { computeProviderAvailability, requireProviderAvailable } from './utils/providerStatus.js';
import { getAdapter } from './adapters/index.js';
import { transcriptionOptionsSchema } from './validation.js';
import type {
  ProviderId,
  RealtimeLatencySummary,
  StorageDriver,
  TranscriptionOptions,
  EvaluationManifest,
} from './types.js';

dotenv.config();

export class HttpError extends Error {
  statusCode: number;
  payload?: Record<string, unknown>;

  constructor(statusCode: number, message: string, payload?: Record<string, unknown>) {
    super(message);
    this.statusCode = statusCode;
    this.payload = payload;
  }
}

interface ParsedBatchRequest {
  files: Express.Multer.File[];
  provider: ProviderId;
  lang: string;
  manifest?: EvaluationManifest;
  options?: TranscriptionOptions;
}

export function parseBatchRequest(
  req: express.Request,
  providerAvailability: ReturnType<typeof computeProviderAvailability>
): ParsedBatchRequest {
  const files = (req.files as Express.Multer.File[]) ?? [];
  const provider = req.body.provider as ProviderId;
  const lang = req.body.lang as string;
  if (!provider || !lang) {
    throw new HttpError(400, 'provider and lang are required');
  }
  if (files.length === 0) {
    throw new HttpError(400, 'no files uploaded');
  }

  try {
    requireProviderAvailable(providerAvailability, provider);
  } catch (err) {
    const statusCode = (err as any).statusCode ?? 400;
    throw new HttpError(statusCode, (err as Error).message, { providers: providerAvailability });
  }

  let manifest: EvaluationManifest | undefined;
  if (req.body.ref_json) {
    try {
      manifest = parseManifest(req.body.ref_json as string);
    } catch (err) {
      throw new HttpError(400, `invalid ref_json: ${(err as Error).message}`);
    }
  }

  let options: TranscriptionOptions | undefined;
  if (req.body.options) {
    try {
      const parsed = JSON.parse(req.body.options as string);
      options = transcriptionOptionsSchema.parse(parsed) as TranscriptionOptions;
    } catch (err) {
      throw new HttpError(400, `invalid options: ${(err as Error).message}`);
    }
  }

  return { files, provider, lang, manifest, options };
}

export function createRealtimeLatencyHandler(
  realtimeLatencyStore: StorageDriver<RealtimeLatencySummary>
) {
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      const raw = Number(req.query.limit ?? 20);
      const limit = Number.isFinite(raw) ? Math.min(50, Math.max(1, raw)) : 20;
      const items =
        typeof realtimeLatencyStore.readRecent === 'function'
          ? await realtimeLatencyStore.readRecent(limit)
          : (await realtimeLatencyStore.readAll()).slice(-limit).reverse();
      res.json(items);
    } catch (error) {
      next(error as Error);
    }
  };
}

function parseAllowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS;
  const defaults = ['http://localhost:4100', 'http://localhost:5173'];
  const list = raw
    ? raw
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
    : defaults;
  // de-duplicate
  return Array.from(new Set(list));
}

const toWsOrigin = (origin: string) => origin.replace(/^http(s?):/, 'ws$1:');

function isOriginAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (!origin) return true; // allow same-host tools like curl
  return allowed.includes(origin);
}

async function bootstrap() {
  const app = express();
  const upload = multer({
    storage: multer.diskStorage({ destination: tmpdir() }),
    limits: { fileSize: 120 * 1024 * 1024 },
  });
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws/stream' });

  let config = await loadConfig();
  let providerAvailability = computeProviderAvailability(config);
  const retention = {
    retentionMs: config.storage.retentionDays
      ? config.storage.retentionDays * 24 * 60 * 60 * 1000
      : undefined,
    maxRows: config.storage.maxRows,
  } as const;
  const storage = createStorage(config.storage.driver, config.storage.path, retention);
  const realtimeLatencyStore = createRealtimeStorage(config.storage.driver, config.storage.path, retention);
  const batchRunner = new BatchRunner(storage);
  await batchRunner.init();
  await realtimeLatencyStore.init();
  logger.info({ event: 'providers_status', providers: providerAvailability });

  const allowedOrigins = parseAllowedOrigins();
  app.use(
    cors({
      origin: (origin, callback) => {
        if (isOriginAllowed(origin ?? undefined, allowedOrigins)) {
          callback(null, true);
          return;
        }
        callback(new Error('Not allowed by CORS'));
      },
    })
  );
  app.use(express.json({ limit: '2mb' }));
  app.use(helmet());
  app.use(
    helmet.contentSecurityPolicy({
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", ...allowedOrigins, ...allowedOrigins.map(toWsOrigin)],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'self'"],
      },
    })
  );
  app.use(morgan('dev'));
  const staticDir = existsSync(path.resolve('client/dist')) ? 'client/dist' : 'public';
  app.use(express.static(path.resolve(staticDir)));

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  app.get('/api/config', (_req, res) => {
    res.json({ audio: { chunkMs: config.audio.chunkMs } });
  });

  app.get('/api/providers', (_req, res) => {
    res.json(providerAvailability);
  });

  app.post('/api/admin/reload-config', async (_req, res, next) => {
    try {
      reloadConfig();
      config = await loadConfig();
      providerAvailability = computeProviderAvailability(config);
      res.json({ status: 'ok', providers: providerAvailability, note: 'storage driver/path are not re-instantiated; restart required to change storage settings' });
    } catch (error) {
      next(error as Error);
    }
  });

  app.post('/api/jobs/transcribe', upload.array('files'), async (req, res, next) => {
    try {
      const parsed = parseBatchRequest(req, providerAvailability);
      const adapter = getAdapter(parsed.provider);
      if (!adapter.supportsBatch) {
        res
          .status(400)
          .json({ message: `Provider ${parsed.provider} does not support batch transcription` });
        return;
      }
      const job = await batchRunner.enqueue(
        parsed.provider,
        parsed.lang,
        parsed.files.map((file) => ({ path: file.path, size: file.size, originalname: file.originalname })),
        parsed.manifest,
        parsed.options
      );
      res.json(job);
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.statusCode).json(error.payload ?? { message: error.message });
        return;
      }
      next(error);
    }
  });

  app.get('/api/jobs/:jobId/status', (req, res) => {
    const status = batchRunner.getStatus(req.params.jobId);
    if (!status) {
      res.status(404).json({ message: 'Job not found' });
      return;
    }
    res.json(status);
  });

  app.get('/api/jobs/:jobId/results', async (req, res) => {
    const results = await batchRunner.getResults(req.params.jobId);
    if (!results) {
      res.status(404).json({ message: 'Job not found' });
      return;
    }
    const format = (req.query.format as string) ?? 'json';
    if (format === 'csv') {
      res.type('text/csv').send(toCsv(results));
      return;
    }
    res.json(results);
  });

  app.get('/api/jobs/:jobId/summary', async (req, res) => {
    try {
      const results = await batchRunner.getResults(req.params.jobId);
      if (!results) {
        res.status(404).json({ message: 'Job not found' });
        return;
      }
      const summary = summarizeJob(results);
      res.json(summary);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  });

  app.get('/api/realtime/latency', createRealtimeLatencyHandler(realtimeLatencyStore));

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ event: 'server_error', message: err.message });
    res.status(500).json({ message: err.message });
  });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const provider = url.searchParams.get('provider') as ProviderId;
    const lang = url.searchParams.get('lang') ?? 'ja-JP';
    const origin = req.headers.origin;
    const allowedOrigins = parseAllowedOrigins();
    if (!isOriginAllowed(origin, allowedOrigins)) {
      ws.send(JSON.stringify({ type: 'error', message: 'origin not allowed' }));
      ws.close();
      return;
    }
    if (!provider) {
      ws.send(JSON.stringify({ type: 'error', message: 'provider query param is required' }));
      ws.close();
      return;
    }
    try {
      requireProviderAvailable(providerAvailability, provider);
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: (err as Error).message }));
      ws.close();
      return;
    }
    handleStreamConnection(ws, provider, lang, realtimeLatencyStore).catch((error) => {
      logger.error({ event: 'ws_handler_error', message: error.message });
      ws.close();
    });
  });

  const port = Number(process.env.SERVER_PORT ?? process.env.PORT ?? 4100);
  server.listen(port, () => {
    logger.info({ event: 'server_started', port });
    console.log(`Server listening on http://localhost:${port}`);
  });
}

if (process.env.NODE_ENV !== 'test') {
  bootstrap().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
