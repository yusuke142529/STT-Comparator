import type { BatchJobFileResult } from '../types.js';

export interface SummaryStats {
  avg: number | null;
  p50: number | null;
  p95: number | null;
}

export interface JobSummary {
  count: number;
  cer: SummaryStats;
  wer: SummaryStats;
  rtf: SummaryStats;
  latencyMs: SummaryStats;
}

function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function summarize(values: Array<number | undefined | null>): SummaryStats {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (nums.length === 0) return { avg: null, p50: null, p95: null };
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
  return { avg, p50: quantile(nums, 0.5), p95: quantile(nums, 0.95) };
}

export function summarizeJob(results: BatchJobFileResult[]): JobSummary {
  return {
    count: results.length,
    cer: summarize(results.map((r) => r.cer)),
    wer: summarize(results.map((r) => r.wer)),
    rtf: summarize(results.map((r) => r.rtf)),
    latencyMs: summarize(results.map((r) => r.latencyMs)),
  };
}

export function summarizeJobByProvider(
  results: BatchJobFileResult[]
): Record<string, JobSummary> {
  const grouped = results.reduce<Record<string, BatchJobFileResult[]>>((acc, row) => {
    const key = row.provider;
    acc[key] = acc[key] ? [...acc[key], row] : [row];
    return acc;
  }, {});
  return Object.fromEntries(
    Object.entries(grouped).map(([provider, rows]) => [provider, summarizeJob(rows)])
  );
}
