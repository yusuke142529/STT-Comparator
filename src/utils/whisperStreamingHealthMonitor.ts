import {
  checkWhisperStreamingHealth,
  normalizeReason,
  pollWhisperStreamingReadiness,
} from './whisperStreamingHealth.js';
import {
  getWhisperStreamingReadyIntervalMs,
  getWhisperStreamingReadyTimeoutMs,
  getWhisperStreamingReadyUrl,
  getWhisperStreamingWsUrl,
} from './whisperStreamingConfig.js';

export interface WhisperStreamingHealthSnapshot {
  available: boolean;
  reason?: string;
  checkedAt: number;
}

export class WhisperStreamingHealthMonitor {
  #readyUrl: string;
  #wsUrl: string;
  #readyTimeoutMs: number;
  #readyIntervalMs: number;
  #refreshMs: number;
  #snapshot: WhisperStreamingHealthSnapshot;
  #inflight: Promise<void> | null = null;

  constructor(refreshMs = 5_000) {
    this.#readyUrl = getWhisperStreamingReadyUrl();
    this.#wsUrl = getWhisperStreamingWsUrl();
    this.#readyTimeoutMs = getWhisperStreamingReadyTimeoutMs();
    this.#readyIntervalMs = getWhisperStreamingReadyIntervalMs();
    this.#refreshMs = Math.max(1, refreshMs);
    this.#snapshot = {
      available: false,
      reason: 'whisper_streaming readiness has not been evaluated yet',
      checkedAt: 0,
    };
  }

  updateRefreshMs(refreshMs: number): void {
    this.#refreshMs = Math.max(1, refreshMs);
  }

  getSnapshot(): WhisperStreamingHealthSnapshot {
    return this.#snapshot;
  }

  triggerCheck(force = false): void {
    const now = Date.now();
    if (!force && this.#inflight) {
      return;
    }
    if (!force && now - this.#snapshot.checkedAt < this.#refreshMs) {
      return;
    }
    if (this.#inflight) {
      return;
    }
    this.#inflight = this.#runCheck().finally(() => {
      this.#inflight = null;
    });
  }

  async forceCheck(): Promise<void> {
    if (this.#inflight) {
      await this.#inflight;
      return;
    }
    this.#inflight = this.#runCheck().finally(() => {
      this.#inflight = null;
    });
    await this.#inflight;
  }

  async #runCheck(): Promise<void> {
    const readyHealth = await pollWhisperStreamingReadiness(
      this.#readyUrl,
      this.#readyTimeoutMs,
      this.#readyIntervalMs
    );
    let available = readyHealth.available;
    let reason = readyHealth.reason;
    if (available) {
      const wsHealth = await checkWhisperStreamingHealth(this.#wsUrl);
      available = wsHealth.available;
      reason = wsHealth.available
        ? undefined
        : wsHealth.reason ?? 'whisper_streaming websocket health check failed';
    }
    this.#snapshot = {
      available,
      reason: available ? undefined : normalizeReason(reason, 'whisper_streaming health check failed'),
      checkedAt: Date.now(),
    };
  }
}
