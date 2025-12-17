import { afterEach, describe, expect, it, vi } from 'vitest';

const OPENAI_CHAT_DEFAULT_URL = 'https://api.openai.com/v1/chat/completions';

const envSnapshot = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_CHAT_URL: process.env.OPENAI_CHAT_URL,
  OPENAI_CHAT_TIMEOUT_MS: process.env.OPENAI_CHAT_TIMEOUT_MS,
};

afterEach(() => {
  process.env.OPENAI_API_KEY = envSnapshot.OPENAI_API_KEY;
  process.env.OPENAI_CHAT_URL = envSnapshot.OPENAI_CHAT_URL;
  process.env.OPENAI_CHAT_TIMEOUT_MS = envSnapshot.OPENAI_CHAT_TIMEOUT_MS;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

describe('getOpenAiChatUrl', () => {
  it('returns the default OpenAI chat URL when unset', async () => {
    delete process.env.OPENAI_CHAT_URL;
    vi.resetModules();
    const { getOpenAiChatUrl } = await import('./openaiChat.js');
    expect(getOpenAiChatUrl()).toBe(OPENAI_CHAT_DEFAULT_URL);
  });

  it('rejects non-https URLs', async () => {
    process.env.OPENAI_CHAT_URL = 'http://api.openai.com/v1/chat/completions';
    vi.resetModules();
    const { getOpenAiChatUrl } = await import('./openaiChat.js');
    expect(() => getOpenAiChatUrl()).toThrow(/https/i);
  });

  it('rejects disallowed hosts', async () => {
    process.env.OPENAI_CHAT_URL = 'https://example.com/v1/chat/completions';
    vi.resetModules();
    const { getOpenAiChatUrl } = await import('./openaiChat.js');
    expect(() => getOpenAiChatUrl()).toThrow(/host/i);
  });

  it('rejects unexpected paths', async () => {
    process.env.OPENAI_CHAT_URL = 'https://api.openai.com/v1/other';
    vi.resetModules();
    const { getOpenAiChatUrl } = await import('./openaiChat.js');
    expect(() => getOpenAiChatUrl()).toThrow(/path/i);
  });
});

describe('generateChatReply', () => {
  it('does not send metadata (requires store=true on OpenAI)', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    delete process.env.OPENAI_CHAT_URL; // use default
    vi.resetModules();
    const { generateChatReply } = await import('./openaiChat.js');

    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      expect(body.metadata).toBeUndefined();
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      } as any;
    });
    vi.stubGlobal('fetch', fetchMock as any);

    const reply = await generateChatReply([{ role: 'system', content: 'sys' }]);
    expect(reply).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('times out when the request never completes', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    delete process.env.OPENAI_CHAT_URL; // use default
    process.env.OPENAI_CHAT_TIMEOUT_MS = '10';

    vi.useFakeTimers();
    vi.resetModules();
    const { generateChatReply } = await import('./openaiChat.js');

    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, init?: RequestInit) => {
        const signal = init?.signal;
        return new Promise((_, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              const err = new Error('aborted');
              (err as any).name = 'AbortError';
              reject(err);
            },
            { once: true }
          );
        }) as any;
      })
    );

    const promise = generateChatReply([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ]);

    vi.advanceTimersByTime(20);

    await expect(promise).rejects.toThrow(/timed out/i);
  });
});
