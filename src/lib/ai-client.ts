import OpenAI from 'openai';

/**
 * SPLIT-254 (M5) — ONE AI provider config for the whole MCP server.
 *
 * Previously `ai-service.ts` read OPENROUTER_API_KEY while `content.ts` and
 * `messaging.ts` read OPENAI_API_KEY. When only one key was provisioned the
 * other tools silently went dead (the listing-content + AI-draft tools, and
 * embedding-backed search). This module resolves a single provider with a
 * fallback chain — mirroring the marketplace's OPENCODE → OPENROUTER pattern —
 * so every AI tool uses whichever key is actually set.
 *
 * Resolution is done LIVE (per call, not at module load) so unit tests that
 * toggle env between cases behave, and serverless cold starts pick up the
 * provisioned key. The chat/embedding model names default per provider but are
 * overridable via AI_CHAT_MODEL / AI_EMBEDDING_MODEL so an operator can track a
 * rotating free-model catalog without a code change.
 */

interface ResolvedProvider {
  apiKey: string;
  baseURL?: string;
  chatModel: string;
  embeddingModel: string;
}

function resolveProvider(): ResolvedProvider | null {
  const chatOverride = process.env.AI_CHAT_MODEL;
  const embedOverride = process.env.AI_EMBEDDING_MODEL;

  if (process.env.OPENCODE_API_KEY) {
    return {
      apiKey: process.env.OPENCODE_API_KEY,
      baseURL: 'https://opencode.ai/zen/v1',
      chatModel: chatOverride || 'deepseek-v4-flash-free',
      embeddingModel: embedOverride || 'text-embedding-3-small',
    };
  }
  if (process.env.OPENROUTER_API_KEY) {
    return {
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
      chatModel: chatOverride || 'meta-llama/llama-3.3-70b-instruct:free',
      embeddingModel: embedOverride || 'text-embedding-3-small',
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      apiKey: process.env.OPENAI_API_KEY,
      chatModel: chatOverride || 'gpt-4o-mini',
      embeddingModel: embedOverride || 'text-embedding-3-small',
    };
  }
  return null;
}

/** True when ANY supported provider key is configured. */
export function isAIConfigured(): boolean {
  return resolveProvider() !== null;
}

let cached: { key: string; baseURL?: string; client: OpenAI } | null = null;

/**
 * The shared OpenAI-compatible client for the resolved provider. Rebuilt only
 * when the resolved key/baseURL changes (so prod builds it once; tests that
 * swap env still get a correctly-keyed client — though tests typically mock the
 * `openai` module entirely).
 */
export function getAIClient(): OpenAI {
  const provider = resolveProvider();
  const key = provider?.apiKey ?? 'MISSING_KEY';
  const baseURL = provider?.baseURL;
  if (!cached || cached.key !== key || cached.baseURL !== baseURL) {
    cached = {
      key,
      baseURL,
      client: new OpenAI({
        apiKey: key,
        ...(baseURL ? { baseURL } : {}),
        defaultHeaders: {
          'HTTP-Referer': 'https://splitmygear.com',
          'X-Title': 'SplitMyGear MCP',
        },
      }),
    };
  }
  return cached.client;
}

export function chatModel(): string {
  return resolveProvider()?.chatModel ?? 'gpt-4o-mini';
}

export function embeddingModel(): string {
  return resolveProvider()?.embeddingModel ?? 'text-embedding-3-small';
}
