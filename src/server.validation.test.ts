import { describe, expect, it } from 'vitest';
import { parseBatchRequest, HttpError } from './server.js';

const availability = [
  { id: 'mock', available: true, implemented: true, supportsStreaming: true, supportsBatch: true },
  { id: 'deepgram', available: false, implemented: true, supportsStreaming: true, supportsBatch: true, reason: 'no key' },
] as const;

const baseReq = () =>
  ({
    files: [{ buffer: Buffer.from('a'), originalname: 'a.wav' }],
    body: { provider: 'mock', lang: 'ja-JP' },
  } as any);

const dummyConfig = {
  audio: { targetSampleRate: 16000, targetChannels: 1, chunkMs: 250 },
  normalization: {},
  storage: { driver: 'jsonl', path: './runs', retentionDays: 30, maxRows: 100000 },
  providers: ['mock'],
  providerLimits: { batchMaxBytes: {} },
} as any;

describe('parseBatchRequest', () => {
  it('ファイルなしは 400', () => {
    const req = baseReq();
    req.files = [] as any;
    expect(() => parseBatchRequest(req as any, availability as any, dummyConfig)).toThrow(HttpError);
    try {
      parseBatchRequest(req as any, availability as any, dummyConfig);
    } catch (err) {
      expect((err as HttpError).statusCode).toBe(400);
      expect((err as Error).message).toMatch(/no files/);
    }
  });

  it('壊れた manifest は 400', () => {
    const req = baseReq();
    req.body.ref_json = 'not-json';
    expect(() => parseBatchRequest(req as any, availability as any, dummyConfig)).toThrow(HttpError);
  });

  it('options の JSON パース失敗で 400', () => {
    const req = baseReq();
    req.body.options = '{bad';
    expect(() => parseBatchRequest(req as any, availability as any, dummyConfig)).toThrow(HttpError);
  });

  it('利用不可プロバイダは理由付きで 400', () => {
    const req = baseReq();
    req.body.provider = 'deepgram';
    try {
      parseBatchRequest(req as any, availability as any, dummyConfig);
    } catch (err) {
      expect((err as HttpError).statusCode).toBe(400);
      expect((err as Error).message).toMatch(/unavailable/);
    }
  });

  it('妥当な入力をパースできる', () => {
    const req = baseReq();
    req.body.options = JSON.stringify({ parallel: 2 });
    req.body.ref_json = JSON.stringify({ version: 1, language: 'ja-JP', items: [{ audio: 'a.wav', ref: 'hello' }] });
    const parsed = parseBatchRequest(req as any, availability as any, dummyConfig);
    expect(parsed.lang).toBe('ja-JP');
    expect(parsed.provider).toBe('mock');
    expect(parsed.manifest?.items[0].audio).toBe('a.wav');
    expect(parsed.options?.parallel).toBe(2);
  });
});
