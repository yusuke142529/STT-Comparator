const DEFAULT_WS_URL = 'ws://localhost:8000/v1/audio/transcriptions';
const DEFAULT_HTTP_URL = 'http://localhost:8000/v1/audio/transcriptions';
const DEFAULT_READY_TIMEOUT_MS = 90_000;
const DEFAULT_READY_INTERVAL_MS = 1_000;

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getWhisperStreamingWsUrl(): string {
  return process.env.WHISPER_WS_URL ?? DEFAULT_WS_URL;
}

export function getWhisperStreamingHttpUrl(): string {
  return process.env.WHISPER_HTTP_URL ?? DEFAULT_HTTP_URL;
}

export function getWhisperStreamingReadyUrl(): string {
  const override = process.env.WHISPER_STREAMING_READY_URL;
  if (override) {
    return override;
  }
  const httpUrl = new URL(getWhisperStreamingHttpUrl());
  httpUrl.pathname = '/health';
  httpUrl.search = '';
  httpUrl.hash = '';
  return httpUrl.toString();
}

export function getWhisperStreamingReadyTimeoutMs(): number {
  return parsePositiveNumber(process.env.WHISPER_STREAMING_READY_TIMEOUT_MS, DEFAULT_READY_TIMEOUT_MS);
}

export function getWhisperStreamingReadyIntervalMs(): number {
  return parsePositiveNumber(process.env.WHISPER_STREAMING_READY_INTERVAL_MS, DEFAULT_READY_INTERVAL_MS);
}
