import type { ProviderAdapter, ProviderId } from '../types.js';
import { MockAdapter } from './mock.js';
import { DeepgramAdapter } from './deepgram.js';
import { ElevenLabsAdapter } from './elevenlabs.js';
import { LocalWhisperAdapter } from './localWhisper.js';
import { WhisperStreamingAdapter } from './whisperStreaming.js';
import { OpenAIAdapter } from './openai.js';

const registry: Map<ProviderId, ProviderAdapter> = new Map();

function ensureAdapterInstances(): void {
  if (registry.size > 0) return;
  const adapters: ProviderAdapter[] = [
    new MockAdapter(),
    new DeepgramAdapter(),
    new ElevenLabsAdapter(),
    new LocalWhisperAdapter(),
    new WhisperStreamingAdapter(),
    new OpenAIAdapter(),
  ];
  adapters.forEach((adapter) => registry.set(adapter.id, adapter));
}

export function getAdapter(id: ProviderId): ProviderAdapter {
  ensureAdapterInstances();
  const adapter = registry.get(id);
  if (!adapter) {
    throw new Error(`Adapter ${id} is not registered`);
  }
  return adapter;
}

export function listAdapters(): ProviderAdapter[] {
  ensureAdapterInstances();
  return Array.from(registry.values());
}
