import { listingTools } from '../src/tools/listings';
import { supabase } from '../src/lib/supabase';

jest.mock('../src/lib/ai-service', () => ({
  aiService: {
    parseSearchQuery: jest.fn().mockResolvedValue({}),
    generateEmbedding: jest.fn().mockResolvedValue(new Array(1536).fill(0.1)),
  },
}));

const mockListings = [
  { id: 'listing-1', name: 'Test 1', category: 'camping', pricePerDay: 50, location: 'Seattle', status: 'available' },
  { id: 'listing-2', name: 'Test 2', category: 'hiking', pricePerDay: 75, location: 'Portland', status: 'available' },
];

const createMockBuilder = (data: any[]): any => {
  const builder: any = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    neq: jest.fn().mockReturnThis(),
    ilike: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    lte: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    not: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue({ data, error: null }),
    single: jest.fn().mockImplementation(() => {
      return Promise.resolve({ data: data[0] || null, error: data.length === 0 ? { message: 'Not found' } : null });
    }),
    then: jest.fn().mockImplementation((callback) => {
      return Promise.resolve(callback({ data, error: null }));
    }),
  };
  return builder;
};

jest.mock('../src/lib/supabase', () => {
  // Hoist data if possible or use local copy
  const localMockListings = [
    { id: 'listing-1', name: 'Test 1', category: 'camping', pricePerDay: 50, location: 'Seattle', status: 'available' },
    { id: 'listing-2', name: 'Test 2', category: 'hiking', pricePerDay: 75, location: 'Portland', status: 'available' },
  ];
  return {
    supabase: {
      from: jest.fn((table: string) => {
        if (table === 'listing') return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          neq: jest.fn().mockReturnThis(),
          ilike: jest.fn().mockReturnThis(),
          gte: jest.fn().mockReturnThis(),
          lte: jest.fn().mockReturnThis(),
          or: jest.fn().mockReturnThis(),
          in: jest.fn().mockReturnThis(),
          not: jest.fn().mockReturnThis(),
          order: jest.fn().mockReturnThis(),
          limit: jest.fn().mockResolvedValue({ data: localMockListings, error: null }),
          single: jest.fn().mockImplementation(() => {
            return Promise.resolve({ data: localMockListings[0] || null, error: null });
          }),
          then: jest.fn().mockImplementation((callback) => {
            return Promise.resolve(callback({ data: localMockListings, error: null }));
          }),
        };
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          limit: jest.fn().mockResolvedValue({ data: [], error: null }),
        };
      }),
      rpc: jest.fn().mockResolvedValue({ data: localMockListings, error: null }),
    },
  };
});

describe('Listing Tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENAI_API_KEY = 'test-key';
  });

  it('should search listings', async () => {
    const results = await listingTools.searchListings({ location: 'Seattle' });
    expect(results).toBeDefined();
  });

  it('should get listing details', async () => {
    const result = await listingTools.getListingDetails('listing-1');
    expect(result).toBeDefined();
  });

  describe('Vector Search', () => {
    it('should call match_listings RPC when query is present', async () => {
      const results = await listingTools.searchListings({ query: 'cozy tent' });
      expect(supabase.rpc).toHaveBeenCalledWith('match_listings', expect.objectContaining({
        match_threshold: 0.5
      }));
      expect(results).toBeDefined();
    });

    it('should call match_listings RPC for similar listings if embedding exists', async () => {
      (supabase.from as jest.Mock).mockImplementationOnce(() => ({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({ 
          data: { id: 'l1', category: 'camping', embedding: [0.1, 0.2] }, 
          error: null 
        }),
      }));

      await listingTools.getSimilarListings('listing-1');
      expect(supabase.rpc).toHaveBeenCalledWith('match_listings', expect.objectContaining({
        match_threshold: 0.7
      }));
    });
  });

  describe('getPersonalizedRecommendations', () => {
    it('should fallback if no history', async () => {
      (supabase.from as jest.Mock).mockImplementation((table) => {
        if (table === 'booking') return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          limit: jest.fn().mockResolvedValue({ data: [], error: null }),
        };
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          order: jest.fn().mockReturnThis(),
          limit: jest.fn().mockResolvedValue({ data: mockListings, error: null }),
        };
      });
      const results = await listingTools.getPersonalizedRecommendations('u1');
      expect(results.length).toBeGreaterThan(0);
    });
  });
});
