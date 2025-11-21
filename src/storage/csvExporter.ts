import type { BatchJobFileResult } from '../types.js';

function csvEscape(value: unknown): string {
  const str = String(value ?? '');
  if (str.includes(',') || str.includes('\n') || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function toCsv(rows: BatchJobFileResult[]): string {
  const header = ['path', 'provider', 'lang', 'cer', 'wer', 'rtf', 'latency_ms', 'text', 'ref_text'];
  const lines = rows.map((row) =>
    [
      csvEscape(row.path),
      row.provider,
      row.lang,
      row.cer ?? '',
      row.wer ?? '',
      row.rtf ?? '',
      row.latencyMs ?? '',
      csvEscape(row.text),
      csvEscape(row.refText),
    ].join(',')
  );
  return [header.join(','), ...lines].join('\n');
}
