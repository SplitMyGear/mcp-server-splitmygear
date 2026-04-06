const mockOpenAI = {
  chat: {
    completions: {
      create: jest.fn().mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({ location: 'Seattle' }) } }],
      }),
    },
  },
  embeddings: {
    create: jest.fn().mockResolvedValue({
      data: [{ embedding: [0.1, 0.2] }],
    }),
  },
};

jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => mockOpenAI);
});

import { aiService } from '../src/lib/ai-service';

describe('AI Service', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, OPENAI_API_KEY: 'test-key' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('parseSearchQuery', () => {
    it('should parse query into structured filters', async () => {
      const result = await aiService.parseSearchQuery('Seattle bike');
      expect(result.location).toBe('Seattle');
      expect(mockOpenAI.chat.completions.create).toHaveBeenCalled();
    });

    it('should return empty object if key is missing', async () => {
      delete process.env.OPENAI_API_KEY;
      const result = await aiService.parseSearchQuery('any');
      expect(result).toEqual({});
    });
  });

  describe('generateEmbedding', () => {
    it('should return vector for text', async () => {
      const result = await aiService.generateEmbedding('text');
      expect(result).toEqual([0.1, 0.2]);
      expect(mockOpenAI.embeddings.create).toHaveBeenCalled();
    });

    it('should return empty array if key is missing', async () => {
      delete process.env.OPENAI_API_KEY;
      const result = await aiService.generateEmbedding('any');
      expect(result).toEqual([]);
    });
  });
});
