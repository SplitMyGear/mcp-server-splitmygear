import { listingTools } from '../src/tools/listings';

// All listing read tools are backend REST clients now (SPLIT-226).
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

describe('Listing Tools (backend REST)', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('searchListings', () => {
    it('uses GET /rentals with structured filters when there is no query (SPLIT-220 canonical alias)', async () => {
      mockBackendRequest.mockResolvedValue({ data: [{ id: 'l1' }], total: 1 });
      const results = await listingTools.searchListings({ location: 'Seattle', category: 'camping' });
      expect(results).toEqual([{ id: 'l1' }]);
      const [method, path] = mockBackendRequest.mock.calls[0];
      expect(method).toBe('GET');
      expect(path).toMatch(/^\/rentals\?/);
      // SPLIT-220: never the legacy /listings path.
      expect(path).not.toMatch(/^\/listings(\?|\/|$)/);
      expect(path).toContain('location=Seattle');
      expect(path).toContain('category=camping');
    });

    it('uses the vibe (semantic) endpoint for a natural-language query (SPLIT-220 canonical alias)', async () => {
      mockBackendRequest.mockResolvedValue({ success: true, data: [{ id: 'v1' }] });
      const results = await listingTools.searchListings({ query: 'cozy lakeside kayak' });
      expect(results).toEqual([{ id: 'v1' }]);
      expect(mockBackendRequest.mock.calls[0][1]).toContain('/rentals/search/vibe?q=');
    });

    it('falls through to structured browse when vibe returns nothing', async () => {
      mockBackendRequest
        .mockResolvedValueOnce({ success: true, data: [] }) // vibe
        .mockResolvedValueOnce({ data: [{ id: 'b1' }] }); // browse
      const results = await listingTools.searchListings({ query: 'obscure' });
      expect(results).toEqual([{ id: 'b1' }]);
      expect(mockBackendRequest.mock.calls[1][1]).toMatch(/^\/rentals\?/);
    });

    it('returns [] on a backend error', async () => {
      mockBackendRequest.mockRejectedValue(new Error('boom'));
      expect(await listingTools.searchListings({ location: 'X' })).toEqual([]);
    });
  });

  describe('getListingDetails', () => {
    it('returns the listing from GET /rentals/:id (SPLIT-220 canonical alias)', async () => {
      mockBackendRequest.mockResolvedValue({ id: 'l1', name: 'Tent' });
      const result = await listingTools.getListingDetails('l1');
      expect(result).toEqual({ id: 'l1', name: 'Tent' });
      expect(mockBackendRequest).toHaveBeenCalledWith('GET', '/rentals/l1');
    });

    it('returns null on a 404', async () => {
      const { BackendApiError } = jest.requireMock('../src/lib/backend-client');
      mockBackendRequest.mockRejectedValue(new BackendApiError(404, 'not found'));
      expect(await listingTools.getListingDetails('missing')).toBeNull();
    });
  });

  describe('checkAvailability', () => {
    it('maps an available backend response', async () => {
      mockBackendRequest.mockResolvedValue({ isAvailable: true });
      const result = await listingTools.checkAvailability('l1', '2026-09-01', '2026-09-03', 2);
      expect(result.available).toBe(true);
      expect(mockBackendRequest.mock.calls[0][1]).toContain('/rentals/l1/availability?');
    });

    it('maps an unavailable backend response', async () => {
      mockBackendRequest.mockResolvedValue({ isAvailable: false, conflicts: [{ type: 'booking' }] });
      const result = await listingTools.checkAvailability('l1', '2026-09-01', '2026-09-03', 2);
      expect(result.available).toBe(false);
    });

    it('reports "Listing not found" on a 404', async () => {
      const { BackendApiError } = jest.requireMock('../src/lib/backend-client');
      mockBackendRequest.mockRejectedValue(new BackendApiError(404, 'nope'));
      const result = await listingTools.checkAvailability('missing', '2026-09-01', '2026-09-03', 2);
      expect(result.available).toBe(false);
      expect(result.message).toBe('Listing not found');
    });
  });

  describe('getSimilarListings', () => {
    it('returns the data array from GET /rentals/:id/similar (SPLIT-220 canonical alias)', async () => {
      mockBackendRequest.mockResolvedValue({ success: true, data: [{ id: 'l2' }], count: 1 });
      const results = await listingTools.getSimilarListings('l1', 5);
      expect(results).toEqual([{ id: 'l2' }]);
      expect(mockBackendRequest.mock.calls[0][1]).toContain('/rentals/l1/similar?limit=5');
    });
  });

  describe('getPersonalizedRecommendations', () => {
    it('forwards the token to GET /ai/recommendations/for-me', async () => {
      mockBackendRequest.mockResolvedValue([{ id: 'r1' }]);
      const results = await listingTools.getPersonalizedRecommendations(TOKEN, 5);
      expect(results).toEqual([{ id: 'r1' }]);
      expect(mockBackendRequest).toHaveBeenCalledWith(
        'GET',
        expect.stringContaining('/ai/recommendations/for-me'),
        { token: TOKEN },
      );
    });

    it('returns [] without a token (never queries the backend)', async () => {
      expect(await listingTools.getPersonalizedRecommendations('', 5)).toEqual([]);
      expect(mockBackendRequest).not.toHaveBeenCalled();
    });
  });
});
