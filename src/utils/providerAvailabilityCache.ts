import type { AppConfig } from '../config.js';
import type { ProviderAvailability } from './providerStatus.js';
import { computeProviderAvailability } from './providerStatus.js';

interface CacheEntry {
  timestamp: number;
  value: ProviderAvailability[];
}

export class ProviderAvailabilityCache {
  #config: AppConfig;
  #refreshMs: number;
  #cache: CacheEntry | null = null;
  #inflight: Promise<ProviderAvailability[]> | null = null;

  constructor(config: AppConfig, refreshMs = 5_000) {
    this.#config = config;
    this.#refreshMs = Math.max(1, refreshMs);
  }

  updateConfig(config: AppConfig, refreshMs?: number): void {
    this.#config = config;
    if (refreshMs !== undefined) {
      this.#refreshMs = Math.max(1, refreshMs);
    }
    this.#cache = null;
    this.#inflight = null;
  }

  async get(forceRefresh = false): Promise<ProviderAvailability[]> {
    const now = Date.now();
    if (!forceRefresh && this.#cache && now - this.#cache.timestamp < this.#refreshMs) {
      return this.#cache.value;
    }
    if (this.#inflight) {
      return this.#inflight;
    }
    this.#inflight = computeProviderAvailability(this.#config)
      .then((value) => {
        this.#cache = { value, timestamp: Date.now() };
        this.#inflight = null;
        return value;
      })
      .catch((error) => {
        this.#inflight = null;
        throw error;
      });
    return this.#inflight;
  }

  async refresh(): Promise<ProviderAvailability[]> {
    return this.get(true);
  }
}
