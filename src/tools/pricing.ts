import { backendRequest, BackendApiError } from '@/lib/backend-client';

/**
 * Pricing tools read anonymized market aggregates from the public backend
 * endpoint GET /rentals/pricing-stats (SPLIT-226) instead of querying the
 * listing table directly with the service-role key. The backend is the single
 * source of truth for what counts as an active, visible listing.
 *
 * SPLIT-220 (taxonomy rename): backend paths use the canonical `/rentals`
 * family. The backend serves both aliases byte-identically
 * (`@Controller(['listings', 'rentals'])`), so the response shape — and these
 * tools' I/O contracts — are unchanged.
 */

type ListingRecord = Record<string, unknown>;

interface PricingAnalysis {
  suggestedPrice: number;
  marketAverage: number;
  marketMedian: number;
  minPrice: number;
  maxPrice: number;
  competitorCount: number;
  confidence: 'high' | 'medium' | 'low';
}

interface PricingStatsResponse {
  category: string;
  location: string | null;
  averagePrice: number;
  medianPrice: number;
  minPrice: number;
  maxPrice: number;
  count: number;
  suggestedPrice: number;
}

const EMPTY_ANALYSIS: PricingAnalysis = {
  suggestedPrice: 0,
  marketAverage: 0,
  marketMedian: 0,
  minPrice: 0,
  maxPrice: 0,
  competitorCount: 0,
  confidence: 'low',
};

function confidenceFor(count: number): PricingAnalysis['confidence'] {
  return count > 10 ? 'high' : count > 3 ? 'medium' : 'low';
}

function qs(params: Record<string, string | undefined>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) usp.set(k, v);
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

export const pricingTools = {
  async suggestListingPrice(
    category: string,
    location?: string,
  ): Promise<PricingAnalysis> {
    try {
      const stats = await backendRequest<PricingStatsResponse>(
        'GET',
        `/rentals/pricing-stats${qs({ category, location })}`,
      );
      // If a location-scoped query found nothing, retry category-wide (matches
      // the previous behaviour).
      if (location && stats.count === 0) {
        return this.suggestListingPrice(category);
      }
      return {
        suggestedPrice: stats.suggestedPrice,
        marketAverage: stats.averagePrice,
        marketMedian: stats.medianPrice,
        minPrice: stats.minPrice,
        maxPrice: stats.maxPrice,
        competitorCount: stats.count,
        confidence: confidenceFor(stats.count),
      };
    } catch (error) {
      console.error(
        'Suggest price error:',
        error instanceof BackendApiError ? error.message : error,
      );
      return { ...EMPTY_ANALYSIS };
    }
  },

  async analyzeCompetitorPricing(
    listingId: string,
  ): Promise<{ currentListing: ListingRecord; analysis: PricingAnalysis }> {
    // Throws BackendApiError(404) for an unknown listing (surfaced to the caller).
    const listing = await backendRequest<ListingRecord>('GET', `/rentals/${listingId}`);
    const analysis = await this.suggestListingPrice(
      String(listing.category ?? ''),
      listing.location ? String(listing.location) : undefined,
    );
    return { currentListing: listing, analysis };
  },
};
