import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import type { BatchResult, PartialTranscript, StreamingSession } from '../types.js';
import { BaseAdapter } from './base.js';

function createMockSession(channel: 'mic' | 'file'): StreamingSession {
  const listeners: {
    data: ((t: PartialTranscript) => void)[];
    error: ((err: Error) => void)[];
    close: (() => void)[];
  } = { data: [], error: [], close: [] };

  const controller = {
    async sendAudio(chunk: ArrayBuffer, _meta?: { captureTs?: number }) {
      // pretend to process chunk
      await delay(10);
      const fakeText = `chunk-${chunk.byteLength}`;
      listeners.data.forEach((cb) =>
        cb({ provider: 'mock', isFinal: false, text: fakeText, timestamp: Date.now(), channel })
      );
    },
    async end() {
      listeners.data.forEach((cb) =>
        cb({
          provider: 'mock',
          isFinal: true,
          text: 'mock transcript',
          timestamp: Date.now(),
          channel,
        })
      );
    },
    async close() {
      listeners.close.forEach((cb) => cb());
    },
  } satisfies StreamingSession['controller'];

  return {
    controller,
    onData(cb) {
      listeners.data.push(cb);
    },
    onError(cb) {
      listeners.error.push(cb);
    },
    onClose(cb) {
      listeners.close.push(cb);
    },
  } satisfies StreamingSession;
}

export class MockAdapter extends BaseAdapter {
  id = 'mock' as const;
  supportsStreaming = true;
  supportsBatch = true;

  async startStreaming(): Promise<StreamingSession> {
    return createMockSession('mic');
  }

  async transcribeFileFromPCM(): Promise<BatchResult> {
    await delay(100);
    return {
      provider: 'mock',
      text: `mock-${randomUUID().slice(0, 6)}`,
      durationSec: 1,
      vendorProcessingMs: 100,
    };
  }
}
