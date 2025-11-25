import { WebSocket } from 'ws';
import type { AppConfig, ProviderId } from '../types.js';
import { listAdapters } from '../adapters/index.js';
import { getWhisperRuntime, resetWhisperRuntimeCache } from './whisper.js';
import { getWhisperStreamingReadyUrl, getWhisperStreamingWsUrl } from './whisperStreamingConfig.js';

export interface ProviderAvailability {
  id: ProviderId;
  available: boolean;
  implemented: boolean;
  supportsStreaming: boolean;
  supportsBatch: boolean;
  reason?: string;
}

const WHISPER_WS_HEALTH_TIMEOUT_MS = 5_000;

async function checkWhisperStreamingHealth(
  wsUrl: string,
  timeoutMs = WHISPER_WS_HEALTH_TIMEOUT_MS
): Promise<{ available: boolean; reason?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      settled = true;
      ws.terminate();
      resolve({ available: false, reason: 'whisper_streaming health check timeout' });
    }, timeoutMs);

    ws.once('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      resolve({ available: true });
    });

    ws.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ available: false, reason: err.message });
    });

    ws.once('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ available: false, reason: 'whisper_streaming socket closed' });
    });
  });
}

async function checkWhisperStreamingHttp(url: string, timeoutMs = 1500): Promise<{ available: boolean; reason?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });
    if (res.ok) {
      return { available: true };
    }
    if (res.status < 500) {
      const text = res.statusText ? ` ${res.statusText}` : '';
      return { available: true, reason: `http ${res.status}${text}` };
    }
    const text = await res.text().catch(() => '');
    return { available: false, reason: `http ${res.status}${text ? ` ${text}` : ''}` };
  } catch (err) {
    return { available: false, reason: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

export async function computeProviderAvailability(config: AppConfig): Promise<ProviderAvailability[]> {
  resetWhisperRuntimeCache();
  const adapters = listAdapters();
  const adapterMap = new Map(adapters.map((a) => [a.id, a]));
  const results: ProviderAvailability[] = [];

  for (const id of config.providers) {
    const adapter = adapterMap.get(id);
    const supportsStreaming = adapter?.supportsStreaming ?? false;
    const supportsBatch = adapter?.supportsBatch ?? false;
    if (!adapter) {
      results.push({
        id,
        available: false,
        implemented: false,
        supportsStreaming,
        supportsBatch,
        reason: 'adapter not implemented',
      });
      continue;
    }
    if (id === 'deepgram' && !process.env.DEEPGRAM_API_KEY) {
      results.push({
        id,
        available: false,
        implemented: true,
        supportsStreaming,
        supportsBatch,
        reason: 'DEEPGRAM_API_KEY is not set',
      });
      continue;
    }
    if (id === 'local_whisper') {
      const runtime = getWhisperRuntime();
      if (!runtime.pythonPath) {
        results.push({
          id,
          available: false,
          implemented: true,
          supportsStreaming,
          supportsBatch,
          reason: runtime.reason ?? 'whisper runtime unavailable',
        });
        continue;
      }
      results.push({
        id,
        available: true,
        implemented: true,
        supportsStreaming,
        supportsBatch,
        reason: supportsStreaming ? undefined : 'streaming is not supported (batch only)',
      });
      continue;
    }
    if (id === 'whisper_streaming') {
      const wsUrl = getWhisperStreamingWsUrl();
      const readyUrl = getWhisperStreamingReadyUrl();
      const [wsHealth, readyHealth] = await Promise.all([
        checkWhisperStreamingHealth(wsUrl),
        checkWhisperStreamingHttp(readyUrl),
      ]);
      const available = wsHealth.available && readyHealth.available;
      const reason = !wsHealth.available
        ? wsHealth.reason ?? 'whisper_streaming websocket health check failed'
        : !readyHealth.available
          ? readyHealth.reason ?? 'whisper_streaming ready endpoint health check failed'
          : undefined;
      results.push({
        id,
        available,
        implemented: true,
        supportsStreaming: true,
        supportsBatch: true,
        reason: available ? undefined : reason,
      });
      continue;
    }
    results.push({ id, available: true, implemented: true, supportsStreaming, supportsBatch });
  }

  return results;
}

export function requireProviderAvailable(
  availability: ProviderAvailability[],
  provider: ProviderId,
  capability: 'streaming' | 'batch' | 'any' = 'any'
): ProviderAvailability {
  const found = availability.find((p) => p.id === provider);
  if (!found) {
    throw new Error(`Provider ${provider} is not allowed by config`);
  }
  if (!found.available) {
    const reason = found.reason ?? 'provider is unavailable';
    const message = `Provider ${provider} unavailable: ${reason}`;
    const err = new Error(message);
    (err as any).statusCode = 400;
    throw err;
  }
  const streamingSupported = found.supportsStreaming !== false;
  const batchSupported = found.supportsBatch !== false;
  if (capability === 'streaming' && !streamingSupported) {
    const err = new Error(`Provider ${provider} does not support streaming`);
    (err as any).statusCode = 400;
    throw err;
  }
  if (capability === 'batch' && !batchSupported) {
    const err = new Error(`Provider ${provider} does not support batch transcription`);
    (err as any).statusCode = 400;
    throw err;
  }
  return found;
}
