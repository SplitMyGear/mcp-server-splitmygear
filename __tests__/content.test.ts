import { contentTools } from '../src/tools/content';
import { BackendApiError } from '../src/lib/backend-client';
import { AI_GENERATION_TIMEOUT_MS } from '../src/lib/timeouts';

// Content tools call the backend AI (SPLIT-277); the MCP holds no LLM provider
// key of its own, so only the backend client is mocked.
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

const TOKEN = 'header.payload.sig';

describe('Content Tools (backend AI)', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('generateListingDescription', () => {
    it('returns the backend description, forwards the token, and maps keywords into subAttributes', async () => {
      mockBackendRequest.mockResolvedValue({ description: 'A great bike for fast rides.' });

      const description = await contentTools.generateListingDescription('Bike', 'cycling', ['light', 'fast'], TOKEN);

      expect(description).toEqual({ ok: true, text: 'A great bike for fast rides.' });
      expect(mockBackendRequest).toHaveBeenCalledWith('POST', '/ai/generate-description', {
        token: TOKEN,
        timeoutMs: AI_GENERATION_TIMEOUT_MS,
        body: { category: 'cycling', name: 'Bike', subAttributes: { keyFeatures: 'light, fast' } },
      });
    });

    it('omits subAttributes when no keywords are provided', async () => {
      mockBackendRequest.mockResolvedValue({ description: 'desc' });

      await contentTools.generateListingDescription('Bike', 'cycling', [], TOKEN);

      expect(mockBackendRequest).toHaveBeenCalledWith('POST', '/ai/generate-description', {
        token: TOKEN,
        timeoutMs: AI_GENERATION_TIMEOUT_MS,
        body: { category: 'cycling', name: 'Bike' },
      });
    });

    it('reports the disabled flag as a failure, never as the description (it could end up in a listing)', async () => {
      mockBackendRequest.mockResolvedValue({ available: false, message: 'AI features are currently disabled.' });

      const description = await contentTools.generateListingDescription('Bike', 'cycling', [], TOKEN);

      expect(description).toEqual({ ok: false, error: 'Nothing was generated: AI features are currently disabled. Write it yourself, or try again later.' });
    });

    it('reports an empty description as a failure', async () => {
      mockBackendRequest.mockResolvedValue({ description: '' });

      const description = await contentTools.generateListingDescription('Bike', 'cycling', [], TOKEN);

      expect(description.ok).toBe(false);
    });

    it('reports a backend failure with its reason', async () => {
      mockBackendRequest.mockRejectedValue(new BackendApiError(500, 'boom'));

      const description = await contentTools.generateListingDescription('Bike', 'cycling', [], TOKEN);

      expect(description).toEqual({ ok: false, error: 'Could not generate the description: boom' });
    });

    it('surfaces a re-auth error (not a silent fallback) on a 401', async () => {
      mockBackendRequest.mockRejectedValue(new BackendApiError(401, 'Unauthorized'));

      const description = await contentTools.generateListingDescription('Bike', 'cycling', [], TOKEN);

      expect(!description.ok && description.error).toMatch(/Authentication required/);
    });

    it('surfaces a re-auth error on a 403', async () => {
      mockBackendRequest.mockRejectedValue(new BackendApiError(403, 'Forbidden'));

      const description = await contentTools.generateListingDescription('Bike', 'cycling', [], TOKEN);

      expect(!description.ok && description.error).toMatch(/Authentication required/);
    });
  });

  describe('improveListingTitle', () => {
    it('returns the optimised title from the backend and forwards the token', async () => {
      mockBackendRequest.mockResolvedValue({ title: 'Pro Lightweight Road Bike' });

      const title = await contentTools.improveListingTitle('Old Title', TOKEN);

      expect(title).toEqual({ ok: true, text: 'Pro Lightweight Road Bike' });
      expect(mockBackendRequest).toHaveBeenCalledWith('POST', '/ai/improve-title', {
        token: TOKEN,
        timeoutMs: AI_GENERATION_TIMEOUT_MS,
        body: { currentTitle: 'Old Title' },
      });
    });

    // Returning the input unchanged read as "this title cannot be improved" when nothing had run (SPLIT-1501).
    it('reports the disabled flag as a failure instead of echoing the original title', async () => {
      mockBackendRequest.mockResolvedValue({ available: false });

      const title = await contentTools.improveListingTitle('Original Title', TOKEN);

      expect(title).toEqual({ ok: false, error: "Nothing was generated: Splitt's AI is unavailable right now. Write it yourself, or try again later." });
    });

    it('reports an empty suggestion as a failure', async () => {
      mockBackendRequest.mockResolvedValue({ title: '' });

      const title = await contentTools.improveListingTitle('Original Title', TOKEN);

      expect(title.ok).toBe(false);
    });

    it('reports a non-auth backend failure instead of echoing the original title', async () => {
      mockBackendRequest.mockRejectedValue(new Error('network'));

      const title = await contentTools.improveListingTitle('Original Title', TOKEN);

      expect(title).toEqual({ ok: false, error: 'Could not improve the title.' });
    });

    it('surfaces a re-auth error (not the unchanged title) on a 401', async () => {
      mockBackendRequest.mockRejectedValue(new BackendApiError(401, 'Unauthorized'));

      const title = await contentTools.improveListingTitle('Original Title', TOKEN);

      expect(title.ok).toBe(false);
      expect(!title.ok && title.error).toMatch(/Authentication required/);
    });

    it('surfaces a re-auth error on a 403', async () => {
      mockBackendRequest.mockRejectedValue(new BackendApiError(403, 'Forbidden'));

      const title = await contentTools.improveListingTitle('Original Title', TOKEN);

      expect(!title.ok && title.error).toMatch(/Authentication required/);
    });
  });
});
