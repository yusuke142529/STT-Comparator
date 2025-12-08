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

export interface EffectiveAudioSpec {
  sampleRate: number;
  channels: 1;
  format: 'pcm16le';
}

export interface StreamingOptions {
  language: string;
  sampleRateHz: number;
  encoding: 'linear16';
  enableInterim?: boolean;
  /** Optional provider-specific model override; falls back to adapter defaults. */
  model?: string;
  /** Optional batch-only model override; falls back to model/defaults. */
  batchModel?: string;
  /** Optional fallback model used when primary fails (batch). */
  fallbackModel?: string;
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
  confidence?: number;
  /** true if provider already inserted punctuation */
  punctuationApplied?: boolean;
  /** true if provider preserved original casing */
  casingApplied?: boolean;
  timestamp: number;
  channel: 'mic' | 'file';
  latencyMs?: number;
  /** Capture timestamp (ms, wall clock) of the audio chunk that produced this transcript, if known. */
  originCaptureTs?: number;
  /** Optional sequence number to correlate audio->transcript when providers keep order. */
  seq?: number;
  degraded?: boolean;
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
  pcm?: boolean;
  degraded?: boolean;
  /** Actual AudioContext sample rate observed on the client. */
  clientSampleRate?: number;
  options?: TranscriptionOptions;
}

export interface StreamingController {
  sendAudio(chunk: ArrayBufferLike, meta?: { captureTs?: number; seq?: number }): Promise<void>;
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

export interface NormalizedTranscriptMessage {
  type: 'normalized';
  provider: ProviderId;
  normalizedId: string;
  segmentId: number;
  windowId: number;
  windowStartMs: number;
  windowEndMs: number;
  textRaw: string;
  textNorm: string;
  /** Portion of text newly added since the previous revision for this provider (optional). */
  textDelta?: string;
  isFinal: boolean;
  revision: number;
  latencyMs?: number;
  originCaptureTs?: number;
  confidence?: number | null;
  punctuationApplied?: boolean | null;
  casingApplied?: boolean | null;
  words?: PartialTranscript['words'];
}

export interface StreamErrorMessage {
  type: 'error';
  message: string;
  provider?: ProviderId;
}

export interface StreamSessionMessage {
  type: 'session';
  sessionId: string;
  provider: ProviderId;
  startedAt: string;
  /** Observed input spec from client/replay source before per-provider resampling. */
  inputSampleRate?: number;
  /** Effective output spec delivered to the provider after resampling. */
  audioSpec?: EffectiveAudioSpec;
}

export type StreamServerMessage =
  | StreamTranscriptMessage
  | NormalizedTranscriptMessage
  | StreamErrorMessage
  | StreamSessionMessage;

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
  allowBasenameFallback?: boolean;
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
  degraded?: boolean;
  opts?: Record<string, unknown>;
  /** Normalization actually applied when scoring */
  normalizationUsed?: NormalizationConfig;
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
  ingressNormalize?: {
    enabled?: boolean;
    targetSampleRate?: number;
    targetChannels?: number;
    peakDbfs?: number;
    maxDurationSec?: number;
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
    compare?: {
      backlogSoft?: number;
      backlogHard?: number;
      maxDropMs?: number;
    };
  };
  providerHealth?: {
    refreshMs?: number;
  };
  providerLimits?: {
    batchMaxBytes?: Partial<Record<ProviderId, number>>;
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
