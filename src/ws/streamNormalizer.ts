import type { ProviderId, PartialTranscript } from '../types.js';
import { normalizeText } from './textNormalize.js';

export interface NormalizedTranscriptEvent {
  provider: ProviderId;
  normalizedId: string;
  segmentId: number;
  windowId: number;
  windowStartMs: number;
  windowEndMs: number;
  textRaw: string;
  textNorm: string;
  isFinal: boolean;
  revision: number;
  latencyMs?: number;
  originCaptureTs?: number;
  confidence?: number | null;
  punctuationApplied?: boolean | null;
  casingApplied?: boolean | null;
  words?: PartialTranscript['words'];
}

type WindowState = {
  revision: number;
  isFinal: boolean;
  textRaw: string;
  textNorm: string;
  textDelta?: string;
  confidence?: number | null;
  punctuationApplied?: boolean | null;
  casingApplied?: boolean | null;
  words?: PartialTranscript['words'];
};

/**
 * Normalizes transcripts into fixed-width time windows so that
 * providers with different emission policies can be visually aligned.
 */
export class StreamNormalizer {
  private readonly bucketMs: number;
  private readonly preset?: string;
  private readonly sessionId: string;
  private readonly windows = new Map<number, Map<ProviderId, WindowState>>();
  private readonly lastFullText = new Map<ProviderId, string>();

  constructor(options: { bucketMs: number; preset?: string; sessionId: string }) {
    this.bucketMs = Math.max(1, options.bucketMs);
    this.preset = options.preset;
    this.sessionId = options.sessionId;
  }

  ingest(provider: ProviderId, transcript: PartialTranscript): NormalizedTranscriptEvent {
    const captureTs =
      transcript.originCaptureTs ??
      (typeof transcript.timestamp === 'number' ? transcript.timestamp : Date.now());
    const windowId = Math.floor(captureTs / this.bucketMs);
    const windowStartMs = windowId * this.bucketMs;
    const windowEndMs = windowStartMs + this.bucketMs;

    const textRaw = transcript.text ?? '';
    const prevFull = this.lastFullText.get(provider) ?? '';
    const lcp = longestCommonPrefix(prevFull, textRaw);
    const textDelta = textRaw.slice(lcp);
    const { textNorm, punctuationApplied, casingApplied } = normalizeText(textDelta || textRaw, this.preset);

    const windowMap = this.windows.get(windowId) ?? new Map<ProviderId, WindowState>();
    const previous = windowMap.get(provider);

    // Once a window is finalized, ignore further interim updates to avoid UI churn.
    if (previous?.isFinal && !transcript.isFinal) {
      const normalizedId = this.buildNormalizedId(provider, windowId, previous.revision);
      return {
        provider,
        normalizedId,
        segmentId: windowId,
        windowId,
        windowStartMs,
        windowEndMs,
        textRaw: previous.textRaw,
        textNorm: previous.textNorm,
        isFinal: true,
        revision: previous.revision,
        latencyMs: transcript.latencyMs ?? undefined,
        originCaptureTs: transcript.originCaptureTs ?? captureTs,
        confidence: previous.confidence ?? null,
        punctuationApplied: previous.punctuationApplied ?? null,
        casingApplied: previous.casingApplied ?? null,
        words: previous.words,
      };
    }

    const revision = (previous?.revision ?? 0) + 1;

    const nextState: WindowState = {
      revision,
      isFinal: transcript.isFinal || previous?.isFinal || false,
      textRaw,
      textNorm,
      textDelta: textDelta || undefined,
      confidence: transcript.confidence ?? previous?.confidence ?? null,
      punctuationApplied: punctuationApplied ?? previous?.punctuationApplied ?? null,
      casingApplied: casingApplied ?? previous?.casingApplied ?? null,
      words: transcript.words,
    };

    windowMap.set(provider, nextState);
    this.windows.set(windowId, windowMap);

    const normalizedId = this.buildNormalizedId(provider, windowId, revision);

    this.lastFullText.set(provider, textRaw);

    return {
      provider,
      normalizedId,
      segmentId: windowId,
      windowId,
      windowStartMs,
      windowEndMs,
      textRaw,
      textNorm,
      textDelta: textDelta || undefined,
      isFinal: nextState.isFinal,
      revision,
      latencyMs: transcript.latencyMs,
      originCaptureTs: transcript.originCaptureTs,
      confidence: nextState.confidence ?? null,
      punctuationApplied: nextState.punctuationApplied ?? null,
      casingApplied: nextState.casingApplied ?? null,
      words: transcript.words,
    };
  }

  private buildNormalizedId(provider: ProviderId, windowId: number, revision: number): string {
    return `${this.sessionId}:${provider}:${windowId}:${revision}`;
  }
}

function longestCommonPrefix(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}
