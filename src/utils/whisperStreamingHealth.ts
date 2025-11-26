import { WebSocket } from 'ws';
import {
  getWhisperStreamingReadyIntervalMs,
  getWhisperStreamingReadyTimeoutMs,
  getWhisperStreamingReadyUrl,
} from './whisperStreamingConfig.js';

const WHISPER_WS_HEALTH_TIMEOUT_MS = 5_000;

export interface WhisperStreamingReadyHealth {
  available: boolean;
  reason?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function checkWhisperStreamingHttp(
  url: string,
  timeoutMs = 1_500
): Promise<WhisperStreamingReadyHealth> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
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

export async function checkWhisperStreamingHealth(
  wsUrl: string,
  timeoutMs = WHISPER_WS_HEALTH_TIMEOUT_MS
): Promise<WhisperStreamingReadyHealth> {
  return new Promise((resolve) => {
    let settled = false;
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      settled = true;
      ws.terminate();
      resolve({ available: false, reason: 'whisper_streaming websocket health check timeout' });
    }, timeoutMs);

    const finalize = (result: WhisperStreamingReadyHealth) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      resolve(result);
    };

    ws.once('open', () => {
      finalize({ available: true });
    });

    ws.once('error', (err) => {
      finalize({ available: false, reason: (err as Error).message });
    });

    ws.once('close', () => {
      finalize({ available: false, reason: 'whisper_streaming socket closed' });
    });
  });
}

export async function pollWhisperStreamingReadiness(
  readyUrl: string,
  timeoutMs: number,
  intervalMs: number
): Promise<WhisperStreamingReadyHealth> {
  const start = Date.now();
  let lastReason: string | undefined;
  while (Date.now() - start < timeoutMs) {
    const attempt = await checkWhisperStreamingHttp(readyUrl, intervalMs);
    if (attempt.available) {
      return { available: true };
    }
    lastReason = attempt.reason;
    if (attempt.reason?.startsWith('http')) {
      break;
    }
    const elapsed = Date.now() - start;
    const remaining = timeoutMs - elapsed;
    if (remaining <= 0) {
      break;
    }
    await delay(Math.min(intervalMs, remaining));
  }
  return { available: false, reason: lastReason ?? 'whisper_streaming ready check timed out' };
}

export function normalizeReason(reason: string | undefined, fallback: string): string {
  const trimmed = reason?.trim();
  if (!trimmed) {
    return fallback;
  }
  return trimmed;
}

export async function waitForWhisperStreamingReady(): Promise<void> {
  if (process.env.NODE_ENV === 'test') {
    return;
  }
  const readyTimeoutMs = getWhisperStreamingReadyTimeoutMs();
  if (readyTimeoutMs <= 0) {
    return;
  }
  const readyUrl = getWhisperStreamingReadyUrl();
  const intervalMs = getWhisperStreamingReadyIntervalMs();
  const readyHealth = await pollWhisperStreamingReadiness(readyUrl, readyTimeoutMs, intervalMs);
  if (!readyHealth.available) {
    const reason = normalizeReason(
      readyHealth.reason,
      `whisper_streaming ready endpoint health check failed`
    );
    throw new Error(`whisper_streaming health check timed out after ${readyTimeoutMs}ms: ${reason}`);
  }
}
