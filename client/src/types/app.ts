export interface TranscriptRow {
  id: string;
  text: string;
  provider: string;
  channel: 'mic' | 'file';
  isFinal: boolean;
  timestamp: number;
  latencyMs?: number;
  degraded?: boolean;
}

export interface TranscriptWord {
  startSec: number;
  endSec: number;
  text: string;
  confidence?: number;
}

export interface JobStatus {
  jobId: string;
  total: number;
  done: number;
  failed: number;
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

export interface JobHistoryEntry {
  jobId: string;
  provider: string;
  lang: string;
  createdAt: string;
  updatedAt: string;
  total: number;
  summary: JobSummary;
}

export interface ProviderInfo {
  id: string;
  available: boolean;
  reason?: string;
  implemented?: boolean;
  supportsStreaming?: boolean;
  supportsBatch?: boolean;
  supportsDictionaryPhrases?: boolean;
  supportsPunctuationPolicy?: boolean;
  supportsContextPhrases?: boolean;
}

export interface FileResult {
  path: string;
  provider: string;
  cer?: number | null;
  wer?: number | null;
  rtf?: number | null;
  latencyMs?: number | null;
  durationSec?: number | null;
  degraded?: boolean;
  text?: string;
}

export interface RealtimeLatencySummary {
  sessionId: string;
  provider: string;
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

export type RealtimeLogPayloadType = 'session' | 'transcript' | 'error' | 'session_end';

export interface RealtimeLogPayloadSession {
  type: 'session';
  sessionId: string;
  provider: string;
  startedAt: string;
}

export interface RealtimeLogPayloadTranscript {
  type: 'transcript';
  provider?: string;
  isFinal: boolean;
  text: string;
  timestamp: number;
  channel: 'mic' | 'file';
  latencyMs?: number;
  words?: TranscriptWord[];
}

export interface RealtimeLogPayloadError {
  type: 'error';
  message: string;
}

export interface RealtimeLogPayloadSessionEnd {
  type: 'session_end';
  endedAt: string;
  reason?: string;
}

export type RealtimeLogPayload =
  | RealtimeLogPayloadSession
  | RealtimeLogPayloadTranscript
  | RealtimeLogPayloadError
  | RealtimeLogPayloadSessionEnd;

export interface RealtimeLogEntry {
  sessionId: string;
  provider: string;
  lang: string;
  recordedAt: string;
  payload: RealtimeLogPayload;
}

export interface RealtimeLogSession {
  sessionId: string;
  provider: string;
  lang: string;
  startedAt: string | null;
  lastRecordedAt: string;
  entryCount: number;
}

export interface WsPayload {
  type: 'session' | 'transcript' | 'error';
  sessionId?: string;
  latencyMs?: number;
  message?: string;
  text?: string;
  provider?: string;
  isFinal?: boolean;
  timestamp?: number;
  degraded?: boolean;
}

export type PunctuationPolicy = 'none' | 'basic' | 'full';

export interface SubmitBatchInput {
  files: FileList | null;
  manifestJson: string;
  provider: string;
  lang: string;
  dictionaryPhrases: string[];
  enableVad: boolean;
  punctuationPolicy: PunctuationPolicy;
  parallel: number;
}
