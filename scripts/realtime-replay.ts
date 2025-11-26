#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { once } from 'node:events';
import process from 'node:process';
import WebSocket from 'ws';
import {
  ProviderId,
  PROVIDER_IDS,
  StreamErrorMessage,
  StreamSessionMessage,
  StreamTranscriptMessage,
  TranscriptionOptions,
} from '../src/types.ts';
import {
  RealtimeReplayConfig,
  buildStreamingConfigMessage,
  computeLatencyStats,
  formatLatencyStats,
} from '../src/utils/realtimeReplay.ts';

type ReplayTarget = {
  id: string;
  filePath: string;
  language: string;
  label: string;
};

type ParsedArgs = {
  help: boolean;
  server?: string;
  provider?: string;
  language?: string;
  ffmpegPath?: string;
  file: string[];
  manifest?: string;
  enableInterim: boolean;
  normalizePreset?: string;
  punctuation?: 'none' | 'basic' | 'full';
  enableVad?: boolean;
  context: string[];
  dictionary: string[];
  dryRun: boolean;
};

type ReplayResult = {
  target: ReplayTarget;
  stats: ReturnType<typeof computeLatencyStats>;
  transcriptCount: number;
  finalTranscriptCount: number;
  error?: Error;
};

const USAGE = `
Realtime replay helper

Usage:
  pnpm exec tsx scripts/realtime-replay.ts [options]

Options:
  --server <url>             WebSocket base URL (default: ws://localhost:4100/ws/stream)
  --provider <id>            Provider ID (default: mock)
  --language <bcp47>         Default language (default: ja-JP)
  --file <path>              Audio file to replay (repeatable)
  --manifest <path>          Manifest with audio entries
  --ffmpeg-path <bin>        FFmpeg executable (default: ffmpeg)
  --enable-interim           Request interim transcripts
  --normalize-preset <name>  Normalization preset to send
  --punctuation <policy>     none/basic/full
  --enable-vad              Mirror VAD flag
  --context <phrase>         Context phrase (repeatable)
  --dictionary <word>        Dictionary boost phrase (repeatable)
  --dry-run                  Build config and exit without streaming
  --help                     Show this message
`;

const DEFAULT_SERVER = 'ws://localhost:4100/ws/stream';
const DEFAULT_PROVIDER: ProviderId = 'mock';
const DEFAULT_LANGUAGE = 'ja-JP';

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    help: false,
    file: [],
    enableInterim: false,
    context: [],
    dictionary: [],
    dryRun: false,
  };

  const pushArray = (key: 'file' | 'context' | 'dictionary', value: string) => {
    result[key].push(value);
  };

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith('--')) {
      continue;
    }
    const [flag, inlineValue] = raw.includes('=') ? raw.split(/=(.*)/s).map((piece) => piece.trim()) : [raw, undefined];
    const name = flag.replace(/^--/, '');
    const nextValue = inlineValue ?? argv[index + 1];
    const hasInline = inlineValue !== undefined;
    const isFlagOnly = !hasInline && (nextValue === undefined || nextValue.startsWith('--'));

    const getValue = () => {
      if (hasInline) {
        return inlineValue!;
      }
      if (!isFlagOnly && nextValue) {
        index += 1;
        return nextValue;
      }
      return '';
    };

    switch (name) {
      case 'help':
        result.help = true;
        break;
      case 'server':
        result.server = getValue();
        break;
      case 'provider':
        result.provider = getValue();
        break;
      case 'language':
        result.language = getValue();
        break;
      case 'file':
        pushArray('file', getValue());
        break;
      case 'manifest':
        result.manifest = getValue();
        break;
      case 'ffmpeg-path':
        result.ffmpegPath = getValue();
        break;
      case 'enable-interim':
        result.enableInterim = !isFlagOnly && getValue().toLowerCase() === 'false' ? false : true;
        break;
      case 'normalize-preset':
        result.normalizePreset = getValue();
        break;
      case 'punctuation': {
        const punctuationValue = getValue();
        if (!['none', 'basic', 'full'].includes(punctuationValue)) {
          throw new Error(`punctuation must be none/basic/full, got ${punctuationValue}`);
        }
        result.punctuation = punctuationValue as ParsedArgs['punctuation'];
        break;
      }
      case 'enable-vad':
        result.enableVad = !isFlagOnly && getValue().toLowerCase() === 'false' ? false : true;
        break;
      case 'context':
        pushArray('context', getValue());
        break;
      case 'dictionary':
        pushArray('dictionary', getValue());
        break;
      case 'dry-run':
        result.dryRun = true;
        break;
      default:
        console.warn(`Unknown option: ${flag}`);
        break;
    }
  }

  return result;
}

function ensureProvider(value?: string): ProviderId {
  const normalized = (value ?? DEFAULT_PROVIDER) as ProviderId;
  if (!PROVIDER_IDS.includes(normalized)) {
    throw new Error(`Provider must be one of ${PROVIDER_IDS.join(', ')}, got ${value}`);
  }
  return normalized;
}

function buildTargets(args: ParsedArgs): ReplayTarget[] {
  const baseLanguage = args.language ?? DEFAULT_LANGUAGE;
  const targets: ReplayTarget[] = [];
  args.file.forEach((filePath) => {
    const resolved = resolve(process.cwd(), filePath);
    validateAudioPath(resolved);
    targets.push({
      id: basename(resolved),
      filePath: resolved,
      language: baseLanguage,
      label: `${basename(resolved)} (${baseLanguage})`,
    });
  });

  if (args.manifest) {
    const manifests = loadManifest(args.manifest, baseLanguage);
    targets.push(...manifests);
  }

  if (targets.length === 0) {
    throw new Error('At least one audio file (--file) or manifest (--manifest) must be provided');
  }

  return targets;
}

function validateAudioPath(path: string): void {
  if (!existsSync(path)) {
    throw new Error(`Audio file not found: ${path}`);
  }
}

function loadManifest(manifestPath: string, fallbackLanguage: string): ReplayTarget[] {
  const resolved = resolve(process.cwd(), manifestPath);
  if (!existsSync(resolved)) {
    throw new Error(`Manifest file not found: ${manifestPath}`);
  }
  const raw = readFileSync(resolved, 'utf8');
  const parsed = JSON.parse(raw ?? '{}');
  if (!Array.isArray(parsed.items)) {
    throw new Error('Manifest must include an items array');
  }
  const baseDir = dirname(resolved);
  return parsed.items
    .map(
      (
        item: {
          audio: string;
          language?: string;
          meta?: { language?: string; id?: string };
        },
        index: number
      ) => {
        if (typeof item.audio !== 'string') {
          throw new Error(`Manifest item ${index + 1} misses an audio path`);
        }
        const audio = resolve(baseDir, item.audio);
        validateAudioPath(audio);
        const language =
          item.language ?? item.meta?.language ?? parsed.language ?? fallbackLanguage;
        return {
          id: item.meta?.id ?? `manifest-${index + 1}`,
          filePath: audio,
          language,
          label: `${item.meta?.id ?? `item-${index + 1}`} (${language})`,
        };
      }
    )
    .filter(Boolean);
}

function buildConfig(args: ParsedArgs): RealtimeReplayConfig {
  const transcriptionOptions: TranscriptionOptions = {};
  if (typeof args.enableVad === 'boolean') {
    transcriptionOptions.enableVad = args.enableVad;
  }
  if (args.punctuation) {
    transcriptionOptions.punctuationPolicy = args.punctuation;
  }
  if (args.dictionary.length > 0) {
    transcriptionOptions.dictionaryPhrases = args.dictionary;
  }

  const config: RealtimeReplayConfig = {
    serverUrl: args.server ?? DEFAULT_SERVER,
    provider: ensureProvider(args.provider),
    ffmpegPath: args.ffmpegPath ?? 'ffmpeg',
    enableInterim: args.enableInterim,
  };

  if (args.normalizePreset) {
    config.normalizePreset = args.normalizePreset;
  }
  if (args.context.length > 0) {
    config.contextPhrases = args.context;
  }
  if (Object.keys(transcriptionOptions).length > 0) {
    config.transcriptionOptions = transcriptionOptions;
  }

  return config;
}

async function runReplayForTarget(config: RealtimeReplayConfig, target: ReplayTarget, dryRun: boolean): Promise<ReplayResult> {
  const url = new URL(config.serverUrl);
  url.searchParams.set('provider', config.provider);
  url.searchParams.set('lang', target.language);

  const ws = new WebSocket(url);
  let childProcess: ReturnType<typeof spawn> | null = null;
  let transcriptCount = 0;
  let finalTranscriptCount = 0;
  const latencies: number[] = [];

  currentHandles.ws = ws;

  const cleanupHandles = () => {
    if (currentHandles.ws === ws) {
      currentHandles.ws = null;
    }
    if (currentHandles.childProcess === childProcess) {
      currentHandles.childProcess = null;
    }
  };

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      return;
    }
    const text = data.toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.warn(`[${target.label}] non-JSON message: ${text}`);
      return;
    }
    if (!parsed || typeof parsed !== 'object') {
      return;
    }
    const payload = parsed as StreamTranscriptMessage | StreamErrorMessage | StreamSessionMessage;
    switch (payload.type) {
      case 'transcript': {
        transcriptCount += 1;
        if (payload.isFinal) {
          finalTranscriptCount += 1;
        }
        const latencyTag = typeof payload.latencyMs === 'number' ? `latency=${payload.latencyMs}ms` : 'latency=n/a';
        const snippet = payload.text ? payload.text.replace(/\s+/g, ' ') : '<empty>';
        console.log(`[${target.label}][${payload.isFinal ? 'final' : 'interim'}][${latencyTag}] ${snippet}`);
        if (typeof payload.latencyMs === 'number') {
          latencies.push(payload.latencyMs);
        }
        break;
      }
      case 'error':
        console.error(`[${target.label}] error: ${payload.message}`);
        break;
      case 'session':
        console.log(`[${target.label}] session ${payload.sessionId} started at ${payload.startedAt}`);
        break;
      default:
        break;
    }
  });

  const openPromise = once(ws, 'open');
  const closePromise = new Promise<void>((resolve, reject) => {
    ws.once('close', () => resolve());
    ws.once('error', (error) => reject(error));
  });

  await openPromise;

  const configMessage = buildStreamingConfigMessage(config);
  ws.send(JSON.stringify(configMessage));

  try {
    if (dryRun) {
      console.log(`[${target.label}] dry-run config: ${JSON.stringify(configMessage)}`);
      ws.close();
      await closePromise;
      return {
        target,
        stats: computeLatencyStats(latencies),
        transcriptCount: 0,
        finalTranscriptCount: 0,
      };
    }

    childProcess = spawn(config.ffmpegPath, [
      '-re',
      '-i',
      target.filePath,
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'libopus',
      '-b:a',
      '64k',
      '-f',
      'webm',
      'pipe:1',
    ]);
    currentHandles.childProcess = childProcess;

    childProcess.stderr.on('data', (chunk) => {
      const message = chunk.toString('utf8').trim();
      if (message) {
        console.warn(`[ffmpeg][${target.label}] ${message}`);
      }
    });

    childProcess.stdout.on('data', (chunk: Buffer) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const shouldContinue = ws.send(chunk, { binary: true });
      if (!shouldContinue) {
        childProcess?.stdout.pause();
        ws.once('drain', () => {
          childProcess?.stdout.resume();
        });
      }
    });

    const ffmpegPromise = new Promise<void>((resolve, reject) => {
      childProcess?.once('exit', (code) => {
        if (code && code !== 0) {
          reject(new Error(`ffmpeg exited with code ${code}`));
          return;
        }
        resolve();
      });
      childProcess?.once('error', reject);
    }).finally(() => {
      if (ws.readyState === WebSocket.OPEN) {
        setTimeout(() => ws.close(), 200);
      }
    });

    await Promise.all([closePromise, ffmpegPromise]);
  } finally {
    cleanupHandles();
  }

  return {
    target,
    stats: computeLatencyStats(latencies),
    transcriptCount,
    finalTranscriptCount,
  };
}

const currentHandles: { childProcess: ReturnType<typeof spawn> | null; ws: WebSocket | null } = {
  childProcess: null,
  ws: null,
};

function setupInterruptHandler(): void {
  process.on('SIGINT', () => {
    console.log('Interrupt received, terminating replay...');
    currentHandles.childProcess?.kill();
    currentHandles.ws?.close();
    process.exit(1);
  });
}

function formatResultSummary(result: ReplayResult): string {
  if (result.error) {
    return `[${result.target.label}] failed: ${result.error.message}`;
  }
  return `[${result.target.label}] transcripts=${result.transcriptCount} finals=${result.finalTranscriptCount} stats=${formatLatencyStats(
    result.stats
  )}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const config = buildConfig(args);
  const targets = buildTargets(args);
  setupInterruptHandler();

  const results: ReplayResult[] = [];
  for (const target of targets) {
    console.log(`\n=== replay ${target.label} ===`);
    try {
      const result = await runReplayForTarget(config, target, args.dryRun);
      results.push(result);
      console.log(formatResultSummary(result));
    } catch (error) {
      const err = error instanceof Error ? error : new Error('unknown');
      console.error(`[${target.label}] replay failed: ${err.message}`);
      results.push({
        target,
        stats: computeLatencyStats([]),
        transcriptCount: 0,
        finalTranscriptCount: 0,
        error: err,
      });
    }
  }

  const overall = results.filter((item) => !item.error);
  if (overall.length > 0) {
    console.log('\n=== overall summary ===');
    overall.forEach((item) => {
      console.log(formatResultSummary(item));
    });
  }

  const failed = results.filter((item) => !!item.error);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

void main();
