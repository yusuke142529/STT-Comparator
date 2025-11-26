export const PROVIDER_IDS = [
  'google',
  'aws',
  'azure',
  'deepgram',
  'elevenlabs',
  'revai',
  'speechmatics',
  'openai',
  'local_whisper',
  'nvidia_riva',
  'whisper_streaming',
  'mock',
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface StreamingOptions {
  language: string;
  sampleRateHz: number;
  encoding: 'linear16';
  enableInterim?: boolean;
  contextPhrases?: readonly string[];
  punctuationPolicy?: PunctuationPolicy;
  enableVad?: boolean;
  dictionaryPhrases?: readonly string[];
  normalizePreset?: string;
  parallel?: number;
}

export interface TranscriptWord {
  startSec: number;
  endSec: number;
  text: string;
  confidence?: number;
}

export interface PartialTranscript {
  provider: ProviderId;
  isFinal: boolean;
  text: string;
  words?: readonly TranscriptWord[];
  timestamp: number;
  channel: 'mic' | 'file';
  latencyMs?: number;
}

export type PunctuationPolicy = 'none' | 'basic' | 'full';

export interface TranscriptionOptions {
  enableVad?: boolean;
  punctuationPolicy?: PunctuationPolicy;
  dictionaryPhrases?: readonly string[];
  parallel?: number;
}

export interface StreamingConfigMessage {
  type: 'config';
  enableInterim?: boolean;
  contextPhrases?: readonly string[];
  normalizePreset?: string;
  options?: TranscriptionOptions;
}

export interface StreamingController {
  sendAudio(chunk: ArrayBufferLike): Promise<void>;
  end(): Promise<void>;
  close(): Promise<void>;
}

export interface StreamingSession {
  controller: StreamingController;
  onData(cb: (t: PartialTranscript) => void): void;
  onError(cb: (err: Error) => void): void;
  onClose(cb: () => void): void;
}

export interface BatchResult {
  provider: ProviderId;
  text: string;
  words?: readonly TranscriptWord[];
  durationSec?: number;
  /**
   * Processing time reported by the provider (if available).
   * Used for observability only; latencyMs is computed server-side for fairness.
   */
  vendorProcessingMs?: number;
}

export interface ProviderAdapter {
  id: ProviderId;
  supportsStreaming: boolean;
  supportsBatch: boolean;
  startStreaming(opts: StreamingOptions): Promise<StreamingSession>;
  transcribeFileFromPCM(
    pcm: NodeJS.ReadableStream,
    opts: StreamingOptions
  ): Promise<BatchResult>;
}

export interface StreamTranscriptMessage extends PartialTranscript {
  type: 'transcript';
}

export interface StreamErrorMessage {
  type: 'error';
  message: string;
}

export interface StreamSessionMessage {
  type: 'session';
  sessionId: string;
  provider: ProviderId;
  startedAt: string;
}

export type StreamServerMessage = StreamTranscriptMessage | StreamErrorMessage | StreamSessionMessage;

export interface StreamSessionEndMessage {
  type: 'session_end';
  endedAt: string;
  reason?: string;
}

export type RealtimeLogPayload = StreamServerMessage | StreamSessionEndMessage;

export interface RealtimeTranscriptLogEntry {
  sessionId: string;
  provider: ProviderId;
  lang: string;
  recordedAt: string;
  payload: RealtimeLogPayload;
}

export interface RealtimeTranscriptSessionSummary {
  sessionId: string;
  provider: ProviderId;
  lang: string;
  startedAt: string | null;
  lastRecordedAt: string;
  entryCount: number;
}

export interface NormalizationConfig {
  nfkc?: boolean;
  stripPunct?: boolean;
  stripSpace?: boolean;
  lowercase?: boolean;
}

export interface ManifestItem {
  audio: string;
  ref: string;
  meta?: Record<string, unknown>;
}

export interface EvaluationManifest {
  version: number;
  language: string;
  items: ManifestItem[];
  normalization?: NormalizationConfig;
}

export interface StorageDriver<T> {
  init(): Promise<void>;
  append(record: T): Promise<void>;
  readAll(): Promise<T[]>;
  readRecent?(limit: number): Promise<T[]>;
  readByJob?(jobId: string): Promise<T[]>;
}

export interface BatchJobFileResult {
  jobId: string;
  path: string;
  provider: ProviderId;
  lang: string;
  durationSec: number;
  /** Server-measured wall clock processing time (enqueue -> adapter return) */
  processingTimeMs: number;
  rtf: number;
  cer?: number;
  wer?: number;
  latencyMs?: number;
  text: string;
  refText?: string;
  opts?: Record<string, unknown>;
  /** ISO timestamp when the record was created (for retention / pruning) */
  createdAt?: string;
  /** Provider-reported processing time (if supplied by adapter) */
  vendorProcessingMs?: number;
}

export type StorageDriverName = 'jsonl' | 'sqlite';

export interface AppConfig {
  audio: {
    targetSampleRate: number;
    targetChannels: number;
    chunkMs: number;
  };
  normalization: NormalizationConfig;
  storage: {
    driver: StorageDriverName;
    path: string;
    retentionDays?: number;
    maxRows?: number;
  };
  providers: ProviderId[];
  jobs?: {
    maxParallel?: number;
    retentionMs?: number;
  };
  ws?: {
    maxPcmQueueBytes?: number;
  };
  providerHealth?: {
    refreshMs?: number;
  };
}

export interface SummaryStats {
  avg: number | null;
  p50: number | null;
  p95: number | null;
}

export interface JobSummary {
  count: number;
  cer: SummaryStats;
  wer: SummaryStats;
  rtf: SummaryStats;
  latencyMs: SummaryStats;
}

export interface RealtimeLatencySummary {
  sessionId: string;
  provider: ProviderId;
  lang: string;
  count: number;
  avg: number | null;
  p50: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
  startedAt: string;
  endedAt: string;
}
