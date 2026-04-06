import { supabase, Listing } from '@/lib/supabase';

interface PricingAnalysis {
  suggestedPrice: number;
  marketAverage: number;
  marketMedian: number;
  minPrice: number;
  maxPrice: number;
  competitorCount: number;
  confidence: 'high' | 'medium' | 'low';
}

export const pricingTools = {
  async suggestListingPrice(
    category: string,
    location?: string
  ): Promise<PricingAnalysis> {
    let query = supabase
      .from('listing')
      .select('pricePerDay')
      .eq('category', category)
      .eq('status', 'active');

    if (location) {
      query = query.ilike('location', `%${location}%`);
    }

    const { data: listings, error } = await query;

    if (error || !listings || listings.length === 0) {
      // If no local data, try category-wide
      if (location) {
        return this.suggestListingPrice(category);
      }
      return {
        suggestedPrice: 0,
        marketAverage: 0,
        marketMedian: 0,
        minPrice: 0,
        maxPrice: 0,
        competitorCount: 0,
        confidence: 'low',
      };
    }

    const prices = listings.map((l) => Number(l.pricePerDay)).sort((a, b) => a - b);
    const sum = prices.reduce((a, b) => a + b, 0);
    const avg = sum / prices.length;
    const median = prices[Math.floor(prices.length / 2)];
    const min = prices[0];
    const max = prices[prices.length - 1];

    // Suggestion logic: slightly below average to be competitive for new listings
    // or at median for established ones. Let's go with 95% of median.
    const suggested = Math.round(median * 0.95 * 100) / 100;

    return {
      suggestedPrice: suggested,
      marketAverage: Math.round(avg * 100) / 100,
      marketMedian: median,
      minPrice: min,
      maxPrice: max,
      competitorCount: listings.length,
      confidence: listings.length > 10 ? 'high' : listings.length > 3 ? 'medium' : 'low',
    };
  },

  async analyzeCompetitorPricing(
    listingId: string
  ): Promise<{ currentListing: Listing; analysis: PricingAnalysis }> {
    const { data: listing } = await supabase
      .from('listing')
      .select('*')
      .eq('id', listingId)
      .single();

    if (!listing) {
      throw new Error('Listing not found');
    }

    const analysis = await this.suggestListingPrice(listing.category, listing.location);

    return {
      currentListing: listing,
      analysis,
    };
  },
};
