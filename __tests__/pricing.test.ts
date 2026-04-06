import { pricingTools } from '../src/tools/pricing';
import { supabase } from '../src/lib/supabase';

const mockListings = [
  { id: 'l1', pricePerDay: 50, category: 'camping', location: 'Seattle' },
  { id: 'l2', pricePerDay: 60, category: 'camping', location: 'Seattle' },
  { id: 'l3', pricePerDay: 70, category: 'camping', location: 'Portland' },
];

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: jest.fn((table: string) => {
      if (table === 'listing') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          ilike: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({ data: mockListings[0], error: null }),
          // Mocking the thenable behavior for the query
          then: (callback: any) => Promise.resolve({ data: mockListings, error: null }).then(callback),
        };
      }
      return {};
    }),
  },
}));

describe('Pricing Tools', () => {
  describe('suggestListingPrice', () => {
    it('should calculate suggestions based on market data', async () => {
      const result = await pricingTools.suggestListingPrice('camping', 'Seattle');
      expect(result.suggestedPrice).toBeGreaterThan(0);
      expect(result.marketAverage).toBeCloseTo(60); 
      expect(result.competitorCount).toBe(3);
    });

    it('should return low confidence if no listings found', async () => {
      (supabase.from as jest.Mock).mockImplementationOnce(() => ({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        ilike: jest.fn().mockReturnThis(),
        then: (callback: any) => Promise.resolve({ data: [], error: null }).then(callback),
      }));
      const result = await pricingTools.suggestListingPrice('unknown');
      expect(result.confidence).toBe('low');
      expect(result.suggestedPrice).toBe(0);
    });
  });

  describe('analyzeCompetitorPricing', () => {
    it('should return analysis for a specific listing', async () => {
      const result = await pricingTools.analyzeCompetitorPricing('l1');
      expect(result.currentListing).toBeDefined();
      expect(result.analysis).toBeDefined();
    });

    it('should throw error if listing not found', async () => {
      (supabase.from as jest.Mock).mockImplementationOnce(() => ({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({ data: null, error: { message: 'Not found' } }),
      }));
      await expect(pricingTools.analyzeCompetitorPricing('invalid')).rejects.toThrow('Listing not found');
    });
  });
});
