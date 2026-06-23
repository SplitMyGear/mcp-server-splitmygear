import { pricingTools } from '../src/tools/pricing';

// Pricing tools read aggregates from the backend now (SPLIT-226).
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

const STATS = {
  category: 'camping',
  location: 'Seattle',
  averagePrice: 60,
  medianPrice: 60,
  minPrice: 50,
  maxPrice: 70,
  count: 5,
  suggestedPrice: 57,
};

describe('Pricing Tools (backend REST)', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('suggestListingPrice', () => {
    it('maps the backend pricing-stats response to a PricingAnalysis', async () => {
      mockBackendRequest.mockResolvedValue(STATS);
      const result = await pricingTools.suggestListingPrice('camping', 'Seattle');
      expect(result.suggestedPrice).toBe(57);
      expect(result.marketAverage).toBe(60);
      expect(result.marketMedian).toBe(60);
      expect(result.competitorCount).toBe(5);
      expect(result.confidence).toBe('medium'); // 3 < 5 <= 10
      // SPLIT-220: canonical /rentals alias (byte-identical to /listings).
      expect(mockBackendRequest.mock.calls[0][1]).toContain('/rentals/pricing-stats?');
      expect(mockBackendRequest.mock.calls[0][1]).not.toContain('/listings/pricing-stats');
      expect(mockBackendRequest.mock.calls[0][1]).toContain('category=camping');
    });

    it('retries category-wide when a location-scoped query is empty', async () => {
      mockBackendRequest
        .mockResolvedValueOnce({ ...STATS, count: 0, suggestedPrice: 0 }) // location: empty
        .mockResolvedValueOnce({ ...STATS, location: null, count: 8, suggestedPrice: 57 }); // category-wide
      const result = await pricingTools.suggestListingPrice('camping', 'Nowhere');
      expect(result.competitorCount).toBe(8);
      // Second call dropped the location filter.
      expect(mockBackendRequest.mock.calls[1][1]).not.toContain('location=');
    });

    it('returns a low-confidence zero analysis on backend error', async () => {
      mockBackendRequest.mockRejectedValue(new Error('boom'));
      const result = await pricingTools.suggestListingPrice('unknown');
      expect(result.confidence).toBe('low');
      expect(result.suggestedPrice).toBe(0);
    });
  });

  describe('analyzeCompetitorPricing', () => {
    it('returns the listing plus its category analysis (SPLIT-220 canonical alias)', async () => {
      mockBackendRequest.mockImplementation(async (_m: string, path: string) => {
        if (path.startsWith('/rentals/pricing-stats')) return STATS;
        return { id: 'l1', category: 'camping', location: 'Seattle' };
      });
      const result = await pricingTools.analyzeCompetitorPricing('l1');
      expect(result.currentListing).toMatchObject({ id: 'l1' });
      expect(result.analysis.suggestedPrice).toBe(57);
      // SPLIT-220: the listing fetch hits /rentals/:id, never the legacy /listings.
      const listingFetch = mockBackendRequest.mock.calls.find(
        (c) => typeof c[1] === 'string' && !(c[1] as string).includes('pricing-stats'),
      );
      expect(listingFetch?.[1]).toBe('/rentals/l1');
    });

    it('throws when the listing is not found (backend 404)', async () => {
      const { BackendApiError } = jest.requireMock('../src/lib/backend-client');
      mockBackendRequest.mockRejectedValue(new BackendApiError(404, 'Listing not found'));
      await expect(pricingTools.analyzeCompetitorPricing('missing')).rejects.toThrow('Listing not found');
    });
  });
});
