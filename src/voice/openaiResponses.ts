import { withTimeoutSignal } from '../utils/abort.js';
import type { UrlCitation } from '../types.js';

type ChatRole = 'system' | 'user' | 'assistant';

export type ChatMessage = { role: ChatRole; content: string };

const DEFAULT_OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const ALLOWED_OPENAI_RESPONSES_HOSTS = new Set(['api.openai.com']);

function normalizeEnvValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function getOpenAiResponsesUrl(): string {
  const raw =
    normalizeEnvValue(process.env.OPENAI_RESPONSES_URL) ??
    normalizeEnvValue(process.env.OPENAI_CHAT_URL) ??
    DEFAULT_OPENAI_RESPONSES_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('OPENAI_RESPONSES_URL must be a valid URL');
  }
  if (url.protocol !== 'https:') {
    throw new Error('OPENAI_RESPONSES_URL must use https');
  }
  if (url.username || url.password) {
    throw new Error('OPENAI_RESPONSES_URL must not include credentials');
  }
  if (!ALLOWED_OPENAI_RESPONSES_HOSTS.has(url.hostname) || (url.port && url.port !== '443')) {
    throw new Error(`OPENAI_RESPONSES_URL host is not allowed: ${url.host}`);
  }
  if (url.pathname !== '/v1/responses') {
    if (url.pathname === '/v1/chat/completions') {
      throw new Error('OPENAI_CHAT_URL is deprecated. Use OPENAI_RESPONSES_URL=/v1/responses');
    }
    throw new Error(`OPENAI_RESPONSES_URL path is not allowed: ${url.pathname}`);
  }
  return url.toString();
}

function getResponsesModel(): string {
  return (
    normalizeEnvValue(process.env.OPENAI_RESPONSES_MODEL) ??
    normalizeEnvValue(process.env.OPENAI_CHAT_MODEL) ??
    'gpt-5.2'
  );
}

function getResponsesTemperature(): number | undefined {
  const raw = normalizeEnvValue(process.env.OPENAI_RESPONSES_TEMPERATURE) ?? process.env.OPENAI_CHAT_TEMPERATURE;
  if (raw === undefined || raw === null) return undefined;
  const value = Number(raw);
  if (Number.isFinite(value)) return value;
  return undefined;
}

function getResponsesTimeoutMs(): number {
  const raw = normalizeEnvValue(process.env.OPENAI_RESPONSES_TIMEOUT_MS) ?? process.env.OPENAI_CHAT_TIMEOUT_MS;
  const value = raw === undefined || raw === null ? NaN : Number(raw);
  if (Number.isFinite(value) && value > 0) return Math.min(5 * 60_000, Math.round(value));
  return 30_000;
}

function getResponsesMaxTokens(): number | undefined {
  const raw = normalizeEnvValue(process.env.OPENAI_RESPONSES_MAX_TOKENS) ?? process.env.OPENAI_CHAT_MAX_TOKENS;
  const value = raw === undefined || raw === null ? NaN : Number(raw);
  if (Number.isFinite(value) && value > 0) return Math.round(value);
  return undefined;
}

function parseBoolean(value: string | undefined): boolean | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function getWebSearchEnabled(): boolean {
  const raw = parseBoolean(process.env.OPENAI_WEB_SEARCH_ENABLED);
  return raw ?? true;
}

function getWebSearchExternalAccess(): boolean | undefined {
  const raw = parseBoolean(process.env.OPENAI_WEB_SEARCH_EXTERNAL_ACCESS);
  return raw ?? undefined;
}

function getWebSearchAllowedDomains(): string[] | undefined {
  const raw = normalizeEnvValue(process.env.OPENAI_WEB_SEARCH_ALLOWED_DOMAINS);
  if (!raw) return undefined;
  const domains = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return domains.length > 0 ? domains : undefined;
}

function getWebSearchContextSize(): string | undefined {
  const raw = normalizeEnvValue(process.env.OPENAI_WEB_SEARCH_CONTEXT_SIZE);
  return raw ?? undefined;
}

function requireApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error('OpenAI API key is required. Set OPENAI_API_KEY in .env');
  }
  return key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function extractTextAndCitations(payload: Record<string, unknown>): { text: string; citations: UrlCitation[] } {
  const output = Array.isArray(payload.output) ? payload.output : [];
  let text = '';
  const citations: UrlCitation[] = [];

  for (const item of output) {
    if (!isRecord(item)) continue;
    if (item.type !== 'message') continue;
    if (item.role !== 'assistant') continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (!isRecord(part)) continue;
      const partType = typeof part.type === 'string' ? part.type : '';
      if (partType !== 'output_text' && partType !== 'text') continue;
      const partText = typeof part.text === 'string' ? part.text : '';
      if (!partText) continue;

      const offset = text.length;
      text += partText;

      const annotations = Array.isArray(part.annotations) ? part.annotations : [];
      for (const annotation of annotations) {
        if (!isRecord(annotation)) continue;
        let citation: Record<string, unknown> | null = null;
        if (annotation.type === 'url_citation') {
          citation = annotation;
        } else if (isRecord(annotation.url_citation)) {
          citation = annotation.url_citation as Record<string, unknown>;
        }
        if (!citation) continue;

        const url = typeof citation.url === 'string' ? citation.url : '';
        if (!url) continue;
        const start = Number(citation.start_index);
        const end = Number(citation.end_index);
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

        const title = typeof citation.title === 'string' ? citation.title : undefined;
        citations.push({
          url,
          title,
          startIndex: offset + Math.max(0, Math.floor(start)),
          endIndex: offset + Math.max(0, Math.floor(end)),
        });
      }
    }
  }

  if (!text) {
    throw new Error('OpenAI responses missing output text');
  }

  return { text, citations };
}

export async function generateChatReply(
  messages: ChatMessage[],
  options?: { signal?: AbortSignal; instructions?: string }
): Promise<{ text: string; citations: UrlCitation[] }> {
  const apiKey = requireApiKey();
  const url = getOpenAiResponsesUrl();
  const timeoutMs = getResponsesTimeoutMs();
  const { signal, didTimeout, cleanup } = withTimeoutSignal({
    signal: options?.signal,
    timeoutMs,
  });

  const payload: Record<string, unknown> = {
    model: getResponsesModel(),
    input: messages.filter((msg) => msg.role !== 'system'),
    store: false,
  };

  if (options?.instructions) {
    payload.instructions = options.instructions;
  }

  const temperature = getResponsesTemperature();
  if (temperature !== undefined) {
    payload.temperature = temperature;
  }

  const maxTokens = getResponsesMaxTokens();
  if (maxTokens) payload.max_output_tokens = maxTokens;

  if (getWebSearchEnabled()) {
    const webSearchTool: Record<string, unknown> = { type: 'web_search' };
    const contextSize = getWebSearchContextSize();
    if (contextSize) {
      webSearchTool.search_context_size = contextSize;
    }
    const allowedDomains = getWebSearchAllowedDomains();
    const externalAccess = getWebSearchExternalAccess();
    if (allowedDomains) {
      webSearchTool.filters = {
        allowed_domains: allowedDomains,
      };
    }
    if (externalAccess === false) {
      webSearchTool.external_web_access = false;
    }
    payload.tools = [webSearchTool];
    payload.tool_choice = 'auto';
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
      throw new Error(`OpenAI responses error (${res.status}): ${text.slice(0, 300)}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    return extractTextAndCitations(data);
  } catch (err) {
    if (didTimeout()) {
      throw new Error(`OpenAI responses request timed out after ${timeoutMs}ms`);
    }
    throw err instanceof Error ? err : new Error('OpenAI responses request failed');
  } finally {
    cleanup();
  }
}
