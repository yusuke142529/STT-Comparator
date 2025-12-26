import type { ProviderId } from '../types.js';
import type { AppConfig } from '../config.js';
import { listAdapters } from '../adapters/index.js';
import { getWhisperRuntime, resetWhisperRuntimeCache } from './whisper.js';
import { WhisperStreamingHealthMonitor } from './whisperStreamingHealthMonitor.js';

export interface ProviderAvailability {
  id: ProviderId;
  available: boolean;
  implemented: boolean;
  supportsStreaming: boolean;
  supportsBatch: boolean;
  reason?: string;
  supportsDictionaryPhrases?: boolean;
  supportsPunctuationPolicy?: boolean;
  supportsContextPhrases?: boolean;
  supportsDiarization?: boolean;
}

interface StatusCodeError extends Error {
  statusCode?: number;
}

function createStatusError(message: string, statusCode = 400): StatusCodeError {
  const error = new Error(message) as StatusCodeError;
  error.statusCode = statusCode;
  return error;
}

export interface ProviderHealthMonitor {
  updateRefreshMs(ms: number): void;
  triggerCheck(): void;
  getSnapshot(): { available: boolean; reason?: string };
  forceCheck(): Promise<void>;
}

interface ComputeProviderAvailabilityOptions {
  monitor?: ProviderHealthMonitor;
  forceHealthCheck?: boolean;
}

const DEFAULT_PROVIDER_HEALTH_REFRESH_MS = 5_000;
const whisperStreamingHealthMonitor = new WhisperStreamingHealthMonitor(DEFAULT_PROVIDER_HEALTH_REFRESH_MS);

interface ProviderFeatureFlags {
  dictionary?: boolean;
  punctuation?: boolean;
  context?: boolean;
  diarization?: boolean;
}

const PROVIDER_FEATURE_OVERRIDES: Record<ProviderId, ProviderFeatureFlags> = {
  deepgram: { dictionary: true, punctuation: true, context: true, diarization: true },
  elevenlabs: { dictionary: false, punctuation: false, context: false, diarization: true },
  openai: { dictionary: true, punctuation: false, context: true, diarization: false },
  local_whisper: {},
  mock: {},
  azure: {},
  aws: {},
  speechmatics: {},
  google: {},
  nvidia_riva: {},
  revai: {},
  whisper_streaming: {},
};

export async function computeProviderAvailability(
  config: AppConfig,
  options?: ComputeProviderAvailabilityOptions
): Promise<ProviderAvailability[]> {
  resetWhisperRuntimeCache();
  const adapters = listAdapters();
  const adapterMap = new Map(adapters.map((a) => [a.id, a]));
  const results: ProviderAvailability[] = [];

  const refreshMs = config.providerHealth?.refreshMs ?? DEFAULT_PROVIDER_HEALTH_REFRESH_MS;
  const healthMonitor = options?.monitor ?? whisperStreamingHealthMonitor;
  healthMonitor.updateRefreshMs(refreshMs);
  if (options?.forceHealthCheck) {
    await healthMonitor.forceCheck();
  }

  for (const id of config.providers) {
    const adapter = adapterMap.get(id);
    const supportsStreaming = adapter?.supportsStreaming ?? false;
    const supportsBatch = adapter?.supportsBatch ?? false;
    if (!adapter) {
      const features = PROVIDER_FEATURE_OVERRIDES[id];
      results.push({
        id,
        available: false,
        implemented: false,
        supportsStreaming,
        supportsBatch,
        reason: 'adapter not implemented',
        supportsDictionaryPhrases: features?.dictionary,
        supportsPunctuationPolicy: features?.punctuation,
        supportsContextPhrases: features?.context,
        supportsDiarization: features?.diarization,
      });
      continue;
    }
    if (id === 'deepgram' && !process.env.DEEPGRAM_API_KEY) {
      const features = PROVIDER_FEATURE_OVERRIDES[id];
      results.push({
        id,
        available: false,
        implemented: true,
        supportsStreaming,
        supportsBatch,
        reason: 'DEEPGRAM_API_KEY is not set',
        supportsDictionaryPhrases: features?.dictionary,
        supportsPunctuationPolicy: features?.punctuation,
        supportsContextPhrases: features?.context,
        supportsDiarization: features?.diarization,
      });
      continue;
    }
    if (id === 'elevenlabs' && !process.env.ELEVENLABS_API_KEY) {
      const features = PROVIDER_FEATURE_OVERRIDES[id];
      results.push({
        id,
        available: false,
        implemented: true,
        supportsStreaming,
        supportsBatch,
        reason: 'ELEVENLABS_API_KEY is not set',
        supportsDictionaryPhrases: features?.dictionary,
        supportsPunctuationPolicy: features?.punctuation,
        supportsContextPhrases: features?.context,
        supportsDiarization: features?.diarization,
      });
      continue;
    }
    if (id === 'openai') {
      const features = PROVIDER_FEATURE_OVERRIDES[id];
      if (!process.env.OPENAI_API_KEY) {
        results.push({
          id,
          available: false,
          implemented: true,
          supportsStreaming,
          supportsBatch,
          reason: 'OPENAI_API_KEY is not set',
          supportsDictionaryPhrases: features?.dictionary,
          supportsPunctuationPolicy: features?.punctuation,
          supportsContextPhrases: features?.context,
          supportsDiarization: features?.diarization,
        });
        continue;
      }
      results.push({
        id,
        available: true,
        implemented: true,
        supportsStreaming,
        supportsBatch,
        supportsDictionaryPhrases: features?.dictionary,
        supportsPunctuationPolicy: features?.punctuation,
        supportsContextPhrases: features?.context,
        supportsDiarization: features?.diarization,
      });
      continue;
    }
    if (id === 'local_whisper') {
      const runtime = getWhisperRuntime();
      if (!runtime.pythonPath) {
        const features = PROVIDER_FEATURE_OVERRIDES[id];
        results.push({
          id,
          available: false,
          implemented: true,
          supportsStreaming,
          supportsBatch,
        reason: runtime.reason ?? 'whisper runtime unavailable',
        supportsDictionaryPhrases: features?.dictionary,
        supportsPunctuationPolicy: features?.punctuation,
        supportsContextPhrases: features?.context,
        supportsDiarization: features?.diarization,
      });
      continue;
    }
    const features = PROVIDER_FEATURE_OVERRIDES[id];
    results.push({
        id,
        available: true,
        implemented: true,
        supportsStreaming,
        supportsBatch,
        reason: supportsStreaming ? undefined : 'streaming is not supported (batch only)',
        supportsDictionaryPhrases: features?.dictionary,
        supportsPunctuationPolicy: features?.punctuation,
        supportsContextPhrases: features?.context,
        supportsDiarization: features?.diarization,
      });
      continue;
    }
    if (id === 'whisper_streaming') {
      healthMonitor.triggerCheck();
      const snapshot = healthMonitor.getSnapshot();
      const features = PROVIDER_FEATURE_OVERRIDES[id];
      results.push({
        id,
        available: snapshot.available,
        implemented: true,
        supportsStreaming: true,
        supportsBatch: true,
        reason: snapshot.available ? undefined : snapshot.reason,
        supportsDictionaryPhrases: features?.dictionary,
        supportsPunctuationPolicy: features?.punctuation,
        supportsContextPhrases: features?.context,
        supportsDiarization: features?.diarization,
      });
      continue;
    }
    const features = PROVIDER_FEATURE_OVERRIDES[id];
    results.push({
      id,
      available: true,
      implemented: true,
      supportsStreaming,
      supportsBatch,
      supportsDictionaryPhrases: features?.dictionary,
      supportsPunctuationPolicy: features?.punctuation,
      supportsContextPhrases: features?.context,
      supportsDiarization: features?.diarization,
    });
  }

  return results;
}

export { whisperStreamingHealthMonitor };

export function requireProviderAvailable(
  availability: ProviderAvailability[],
  provider: ProviderId,
  capability: 'streaming' | 'batch' | 'any' = 'any'
): ProviderAvailability {
  const found = availability.find((p) => p.id === provider);
  if (!found) {
    throw createStatusError(`Provider ${provider} is not allowed by config`);
  }
  if (!found.available) {
    const reason = found.reason ?? 'provider is unavailable';
    const message = `Provider ${provider} unavailable: ${reason}`;
    throw createStatusError(message);
  }
  const streamingSupported = found.supportsStreaming !== false;
  const batchSupported = found.supportsBatch !== false;
  if (capability === 'streaming' && !streamingSupported) {
    throw createStatusError(`Provider ${provider} does not support streaming`);
  }
  if (capability === 'batch' && !batchSupported) {
    throw createStatusError(`Provider ${provider} does not support batch transcription`);
  }
  return found;
}
