import { contentTools } from '../src/tools/content';
import { BackendApiError } from '../src/lib/backend-client';

// Content tools call the backend AI (SPLIT-277) — the MCP no longer holds an LLM
// provider key, so there is no `openai` mock here.
const mockBackendRequest = jest.fn();
jest.mock('../src/lib/backend-client', () => {
  class BackendApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'BackendApiError';
      this.status = status;
    }
  }
  return {
    BackendApiError,
    backendRequest: (...args: unknown[]) => mockBackendRequest(...args),
  };
});

describe('Content Tools (backend AI)', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('generateListingDescription', () => {
    it('returns the backend description and maps keywords into subAttributes', async () => {
      mockBackendRequest.mockResolvedValue({ description: 'A great bike for fast rides.' });

      const description = await contentTools.generateListingDescription('Bike', 'cycling', ['light', 'fast']);

      expect(description).toBe('A great bike for fast rides.');
      expect(mockBackendRequest).toHaveBeenCalledWith('POST', '/ai/generate-description', {
        body: { category: 'cycling', name: 'Bike', subAttributes: { keyFeatures: 'light, fast' } },
      });
    });

    it('omits subAttributes when no keywords are provided', async () => {
      mockBackendRequest.mockResolvedValue({ description: 'desc' });

      await contentTools.generateListingDescription('Bike', 'cycling', []);

      expect(mockBackendRequest).toHaveBeenCalledWith('POST', '/ai/generate-description', {
        body: { category: 'cycling', name: 'Bike' },
      });
    });

    it('surfaces the disabled notice when the backend AI flag is off', async () => {
      mockBackendRequest.mockResolvedValue({ available: false, message: 'AI features are currently disabled.' });

      const description = await contentTools.generateListingDescription('Bike', 'cycling', []);

      expect(description).toContain('disabled');
    });

    it('returns a friendly error on backend failure', async () => {
      mockBackendRequest.mockRejectedValue(new BackendApiError(500, 'boom'));

      const description = await contentTools.generateListingDescription('Bike', 'cycling', []);

      expect(description).toContain('Error generating description');
    });
  });

  describe('improveListingTitle', () => {
    it('returns the optimised title from the backend', async () => {
      mockBackendRequest.mockResolvedValue({ title: 'Pro Lightweight Road Bike' });

      const title = await contentTools.improveListingTitle('Old Title');

      expect(title).toBe('Pro Lightweight Road Bike');
      expect(mockBackendRequest).toHaveBeenCalledWith('POST', '/ai/improve-title', {
        body: { currentTitle: 'Old Title' },
      });
    });

    it('returns the original title when the backend AI flag is off', async () => {
      mockBackendRequest.mockResolvedValue({ available: false });

      const title = await contentTools.improveListingTitle('Original Title');

      expect(title).toBe('Original Title');
    });

    it('returns the original title on backend failure', async () => {
      mockBackendRequest.mockRejectedValue(new Error('network'));

      const title = await contentTools.improveListingTitle('Original Title');

      expect(title).toBe('Original Title');
    });
  });
});
