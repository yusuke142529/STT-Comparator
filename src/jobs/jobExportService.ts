import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../logger.js';
import { toCsv } from '../storage/csvExporter.js';
import type { BatchJobFileResult } from '../types.js';

function toDateSegment(rows: BatchJobFileResult[]): string {
  const timestamp = rows[0]?.createdAt ?? new Date().toISOString();
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString().split('T')[0];
  }
  return parsed.toISOString().split('T')[0];
}

export class JobExportService {
  private readonly basePath: string;

  constructor(storagePath: string) {
    this.basePath = path.resolve(storagePath);
  }

  async export(jobId: string, rows: BatchJobFileResult[]): Promise<void> {
    const dir = path.resolve(this.basePath, 'jobs', toDateSegment(rows), jobId);
    try {
      await mkdir(dir, { recursive: true });
      const jsonPath = path.resolve(dir, 'results.json');
      const csvPath = path.resolve(dir, 'results.csv');
      await Promise.all([
        writeFile(jsonPath, `${JSON.stringify(rows, null, 2)}\n`, 'utf-8'),
        writeFile(csvPath, `${toCsv(rows)}\n`, 'utf-8'),
      ]);
    } catch (error) {
      logger.error({ event: 'batch_export_failed', jobId, message: (error as Error).message });
      throw error;
    }
  }
}
