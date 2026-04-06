const mockChatResponse = {
  choices: [{ message: { content: 'Test content response' } }],
};

jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue(mockChatResponse),
      },
    },
  }));
});

import { contentTools } from '../src/tools/content';

describe('Content Tools', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv, OPENAI_API_KEY: 'test-key' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('generateListingDescription', () => {
    it('should call OpenAI and return content', async () => {
      const description = await contentTools.generateListingDescription('Bike', 'cycling', ['light', 'fast']);
      expect(description).toBe('Test content response');
    });

    it('should return warning message if key is missing', async () => {
      delete process.env.OPENAI_API_KEY;
      const description = await contentTools.generateListingDescription('Bike', 'cycling', []);
      expect(description).toContain('disabled');
    });
  });

  describe('improveListingTitle', () => {
    it('should optimize current title', async () => {
      const title = await contentTools.improveListingTitle('Old Title');
      expect(title).toBe('Test content response');
    });

    it('should return original title if key is missing', async () => {
      delete process.env.OPENAI_API_KEY;
      const title = await contentTools.improveListingTitle('Original Title');
      expect(title).toBe('Original Title');
    });
  });
});
