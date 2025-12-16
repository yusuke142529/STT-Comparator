import { withTimeoutSignal } from '../utils/abort.js';

type ChatRole = 'system' | 'user' | 'assistant';

export type ChatMessage = { role: ChatRole; content: string };

const DEFAULT_OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const ALLOWED_OPENAI_CHAT_HOSTS = new Set(['api.openai.com']);

export function getOpenAiChatUrl(): string {
  const raw = process.env.OPENAI_CHAT_URL ?? DEFAULT_OPENAI_CHAT_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('OPENAI_CHAT_URL must be a valid URL');
  }
  if (url.protocol !== 'https:') {
    throw new Error('OPENAI_CHAT_URL must use https');
  }
  if (url.username || url.password) {
    throw new Error('OPENAI_CHAT_URL must not include credentials');
  }
  if (!ALLOWED_OPENAI_CHAT_HOSTS.has(url.hostname) || (url.port && url.port !== '443')) {
    throw new Error(`OPENAI_CHAT_URL host is not allowed: ${url.host}`);
  }
  if (url.pathname !== '/v1/chat/completions') {
    throw new Error(`OPENAI_CHAT_URL path is not allowed: ${url.pathname}`);
  }
  return url.toString();
}

function getChatModel(): string {
  return process.env.OPENAI_CHAT_MODEL ?? 'gpt-4o-mini';
}

function getChatTemperature(): number {
  const raw = Number(process.env.OPENAI_CHAT_TEMPERATURE);
  if (Number.isFinite(raw)) return raw;
  return 0.7;
}

function getChatTimeoutMs(): number {
  const raw = Number(process.env.OPENAI_CHAT_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) return Math.min(5 * 60_000, Math.round(raw));
  return 30_000;
}

function getChatMaxTokens(): number | undefined {
  const raw = Number(process.env.OPENAI_CHAT_MAX_TOKENS);
  if (Number.isFinite(raw) && raw > 0) return Math.round(raw);
  return undefined;
}

function requireApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error('OpenAI API key is required. Set OPENAI_API_KEY in .env');
  }
  return key;
}

function coerceContent(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (!part || typeof part !== 'object') return '';
        const record = part as Record<string, unknown>;
        if (typeof record.text === 'string') return record.text;
        if (typeof record.content === 'string') return record.content;
        return '';
      })
      .join('');
    return parts.trim().length > 0 ? parts : null;
  }
  return null;
}

export async function generateChatReply(
  messages: ChatMessage[],
  options?: { lang?: string; signal?: AbortSignal }
): Promise<string> {
  const apiKey = requireApiKey();
  const url = getOpenAiChatUrl();
  const timeoutMs = getChatTimeoutMs();
  const { signal, didTimeout, cleanup } = withTimeoutSignal({
    signal: options?.signal,
    timeoutMs,
  });
  const payload: Record<string, unknown> = {
    model: getChatModel(),
    messages,
    temperature: getChatTemperature(),
  };
  const maxTokens = getChatMaxTokens();
  if (maxTokens) {
    payload.max_tokens = maxTokens;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenAI chat error (${res.status}): ${text.slice(0, 300)}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    const choices = Array.isArray(data.choices) ? (data.choices as unknown[]) : [];
    const first = choices[0] as Record<string, unknown> | undefined;
    const message =
      first && typeof first === 'object' ? (first.message as Record<string, unknown> | undefined) : undefined;
    const content = message ? coerceContent(message.content) : null;
    if (content) return content.trim();

    throw new Error('OpenAI chat response missing content');
  } catch (err) {
    if (didTimeout()) {
      throw new Error(`OpenAI chat request timed out after ${timeoutMs}ms`);
    }
    throw err instanceof Error ? err : new Error('OpenAI chat request failed');
  } finally {
    cleanup();
  }
}
