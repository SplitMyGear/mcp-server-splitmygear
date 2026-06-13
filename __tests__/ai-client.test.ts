/**
 * SPLIT-254 (M5) — the unified AI provider resolver. One key, one client,
 * shared by every AI tool, with a fallback chain and model overrides.
 */
jest.mock('openai', () =>
  jest.fn().mockImplementation((opts: any) => ({ __opts: opts })),
);

import {
  isAIConfigured,
  getAIClient,
  chatModel,
  embeddingModel,
} from '../src/lib/ai-client';

const ENV = process.env;
beforeEach(() => {
  process.env = { ...ENV };
  delete process.env.OPENCODE_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.AI_CHAT_MODEL;
  delete process.env.AI_EMBEDDING_MODEL;
});
afterAll(() => {
  process.env = ENV;
});

describe('isAIConfigured', () => {
  it('is false when no provider key is set', () => {
    expect(isAIConfigured()).toBe(false);
  });
  it.each(['OPENCODE_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY'])(
    'is true when %s is set',
    (key) => {
      process.env[key] = 'k';
      expect(isAIConfigured()).toBe(true);
    },
  );
});

describe('provider precedence and models', () => {
  it('prefers OpenCode (zen) when its key is present', () => {
    process.env.OPENCODE_API_KEY = 'oc';
    process.env.OPENROUTER_API_KEY = 'or';
    process.env.OPENAI_API_KEY = 'oa';
    expect(chatModel()).toBe('deepseek-v4-flash-free');
    expect((getAIClient() as any).__opts.baseURL).toBe(
      'https://opencode.ai/zen/v1',
    );
  });
  it('falls back to OpenRouter when OpenCode is absent', () => {
    process.env.OPENROUTER_API_KEY = 'or';
    process.env.OPENAI_API_KEY = 'oa';
    expect(chatModel()).toBe('meta-llama/llama-3.3-70b-instruct:free');
    expect((getAIClient() as any).__opts.baseURL).toBe(
      'https://openrouter.ai/api/v1',
    );
  });
  it('falls back to OpenAI (no baseURL) when only OPENAI_API_KEY is set', () => {
    process.env.OPENAI_API_KEY = 'oa';
    expect(chatModel()).toBe('gpt-4o-mini');
    expect((getAIClient() as any).__opts.baseURL).toBeUndefined();
  });
  it('honours AI_CHAT_MODEL / AI_EMBEDDING_MODEL overrides', () => {
    process.env.OPENROUTER_API_KEY = 'or';
    process.env.AI_CHAT_MODEL = 'custom-chat';
    process.env.AI_EMBEDDING_MODEL = 'custom-embed';
    expect(chatModel()).toBe('custom-chat');
    expect(embeddingModel()).toBe('custom-embed');
  });
});

describe('getAIClient', () => {
  it('passes the resolved key to the OpenAI client', () => {
    process.env.OPENROUTER_API_KEY = 'secret-or-key';
    expect((getAIClient() as any).__opts.apiKey).toBe('secret-or-key');
  });
});
