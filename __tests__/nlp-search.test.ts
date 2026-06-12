import { listingTools } from '../src/tools/listings';
import { supabase } from '../src/lib/supabase';
import { aiService } from '../src/lib/ai-service';

// Mock Supabase
jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    ilike: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    lte: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
  },
}));

// Mock aiService
jest.mock('../src/lib/ai-service', () => ({
  aiService: {
    parseSearchQuery: jest.fn().mockResolvedValue({
      location: 'Seattle',
      maxPrice: 50,
      query: 'bike',
    }),
  },
}));

describe('NLP Search Verification', () => {
  it('should call aiService.parseSearchQuery and use refined filters', async () => {
    const complexQuery = 'find me a bike for this weekend in Seattle under $50';
    
    await listingTools.searchListings({ query: complexQuery });

    expect(aiService.parseSearchQuery).toHaveBeenCalledWith(complexQuery);
    
    // It SHOULD extract location and price and use them in query
    expect((supabase as any).ilike).toHaveBeenCalledWith('location', '%Seattle%');
    expect((supabase as any).lte).toHaveBeenCalledWith('pricePerDay', 50);
  });
});
