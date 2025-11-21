import type { AppConfig, ProviderId } from '../types.js';
import { listAdapters } from '../adapters/index.js';

export interface ProviderAvailability {
  id: ProviderId;
  available: boolean;
  implemented: boolean;
  reason?: string;
}

export function computeProviderAvailability(config: AppConfig): ProviderAvailability[] {
  const implemented = new Set(listAdapters().map((a) => a.id));
  return config.providers.map((id) => {
    if (!implemented.has(id)) {
      return { id, available: false, implemented: false, reason: 'adapter not implemented' };
    }
    if (id === 'deepgram' && !process.env.DEEPGRAM_API_KEY) {
      return { id, available: false, implemented: true, reason: 'DEEPGRAM_API_KEY is not set' };
    }
    return { id, available: true, implemented: true };
  });
}

export function requireProviderAvailable(
  availability: ProviderAvailability[],
  provider: ProviderId
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
  return found;
}
