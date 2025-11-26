import type { RealtimeLatencySummary, StorageDriver, ProviderId } from '../types.js';

function summarizeLatency(values: number[]) {
  if (values.length === 0) {
    return { count: 0, avg: null, p50: null, p95: null, min: null, max: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = (q: number) => {
    const pos = (sorted.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    if (sorted[base + 1] !== undefined) return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
    return sorted[base];
  };
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return {
    count: values.length,
    avg,
    p50: quantile(0.5),
    p95: quantile(0.95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

export async function persistLatency(
  values: number[],
  meta: { sessionId: string; provider: ProviderId; lang: string; startedAt: string },
  store?: StorageDriver<RealtimeLatencySummary>
) {
  if (!store) return;
  const endedAt = new Date().toISOString();
  const stats = summarizeLatency(values);
  if (stats.count === 0) return;
  await store.append({
    ...stats,
    sessionId: meta.sessionId,
    provider: meta.provider,
    lang: meta.lang,
    startedAt: meta.startedAt,
    endedAt,
  });
}
