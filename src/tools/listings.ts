import { backendRequest, BackendApiError } from '@/lib/backend-client';
import type { Listing } from '@/lib/api-contract';

/**
 * Listing read tools are thin clients of the public backend REST API (SPLIT-226)
 * — the canonical, moderation-filtered source. This drops the direct
 * service-role Supabase reads (which targeted a divergent schema) AND the
 * duplicated embedding/match_listings logic, which now lives behind the
 * backend's /rentals/search/vibe + /rentals/:id/similar endpoints.
 *
 * SPLIT-220 (taxonomy rename): backend paths use the canonical `/rentals`
 * family. The backend serves both aliases byte-identically
 * (`@Controller(['listings', 'rentals'])`), so the response shape — and these
 * tools' I/O contracts — are unchanged.
 *
 * SPLIT-197 §C-MCP: `ListingRecord` is now the generated `Listing` entity from
 * the backend OpenAPI contract instead of an untyped `Record<string, unknown>`.
 * NOTE: the read routes below (`GET /rentals*`) declare no typed response schema
 * in the spec (only a bare `object`), so their result envelopes are modelled
 * with the narrow local types below over the generated `Listing` element type —
 * a documented contract gap (see `@/lib/api-contract`).
 */

type ListingRecord = Listing;

/** GET /rentals & /rentals/search/vibe & /rentals/{id}/similar wrap results in a
 *  `data` array (vibe/similar also carry `success`). Untyped in the spec. */
type ListingListResponse = { success?: boolean; data?: ListingRecord[] };

/** GET /rentals/{id}/availability. Untyped in the spec (contract gap). */
type AvailabilityResponse = { isAvailable: boolean; conflicts?: unknown[] };

export interface SearchFilters {
  location?: string;
  checkIn?: string;
  checkOut?: string;
  guests?: number;
  category?: string;
  minPrice?: number;
  maxPrice?: number;
  query?: string;
}

function toMessage(error: unknown, fallback: string): string {
  return error instanceof BackendApiError ? error.message : fallback;
}

function qs(params: Record<string, string | number | undefined>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

export const listingTools = {
  async searchListings(filters: SearchFilters): Promise<ListingRecord[]> {
    try {
      // A natural-language query → the backend's semantic "vibe" search, which
      // runs the embedding + match_listings pgvector RPC server-side.
      if (filters.query) {
        const vibe = await backendRequest<ListingListResponse>(
          'GET',
          `/rentals/search/vibe${qs({ q: filters.query, limit: 50 })}`,
        );
        if (Array.isArray(vibe?.data) && vibe.data.length > 0) return vibe.data;
        // Fall through to structured browse if vibe returns nothing.
      }

      const browse = await backendRequest<ListingListResponse>(
        'GET',
        `/rentals${qs({
          search: filters.query,
          category: filters.category,
          location: filters.location,
          minPrice: filters.minPrice,
          maxPrice: filters.maxPrice,
          startDate: filters.checkIn,
          endDate: filters.checkOut,
          limit: 50,
        })}`,
      );
      return Array.isArray(browse?.data) ? browse.data : [];
    } catch (error) {
      console.error('Search listings error:', toMessage(error, 'unknown'));
      return [];
    }
  },

  async getListingDetails(listingId: string, token?: string): Promise<ListingRecord | null> {
    try {
      // GET /rentals/:id is OptionalJwtAuthGuard-ed: forwarding the caller's
      // token lets an owner see their private fields (tax address, iCal URL).
      return token
        ? await backendRequest<ListingRecord>('GET', `/rentals/${listingId}`, { token })
        : await backendRequest<ListingRecord>('GET', `/rentals/${listingId}`);
    } catch (error) {
      // 404 → not found (matches the prior null contract); log only the unexpected.
      if (!(error instanceof BackendApiError)) console.error('Get listing error:', error);
      return null;
    }
  },

  async checkAvailability(
    listingId: string,
    checkIn: string,
    checkOut: string,
    guests: number,
  ): Promise<{ available: boolean; message: string }> {
    try {
      const result = await backendRequest<AvailabilityResponse>(
        'GET',
        `/rentals/${listingId}/availability${qs({ startDate: checkIn, endDate: checkOut, guests })}`,
      );
      return result.isAvailable
        ? { available: true, message: 'Dates are available' }
        : { available: false, message: 'Selected dates are not available' };
    } catch (error) {
      if (error instanceof BackendApiError && error.status === 404) {
        return { available: false, message: 'Listing not found' };
      }
      // Fail safe: never report availability we could not actually confirm.
      return { available: false, message: toMessage(error, 'Unable to verify availability') };
    }
  },

  /** Day-by-day availability for a window (public). */
  async getAvailabilityCalendar(listingId: string, from: string, to: string): Promise<unknown> {
    return backendRequest('GET', `/rentals/${listingId}/availability/calendar${qs({ from, to })}`);
  },

  async getSimilarListings(listingId: string, limit = 5): Promise<ListingRecord[]> {
    try {
      const result = await backendRequest<ListingListResponse>(
        'GET',
        `/rentals/${listingId}/similar${qs({ limit })}`,
      );
      return Array.isArray(result?.data) ? result.data : [];
    } catch (error) {
      console.error('Similar listings error:', toMessage(error, 'unknown'));
      return [];
    }
  },

  async getPersonalizedRecommendations(token: string, limit = 5): Promise<ListingRecord[]> {
    if (!token) return [];
    try {
      // The backend derives the user from the forwarded JWT (no caller-supplied
      // id — closes the IDOR). Endpoint returns Listing[]; tolerate a wrapped shape.
      const result = await backendRequest<ListingRecord[] | { data: ListingRecord[] }>(
        'GET',
        `/ai/recommendations/for-me${qs({ limit })}`,
        { token },
      );
      if (Array.isArray(result)) return result;
      if (result && Array.isArray((result as { data?: ListingRecord[] }).data)) {
        return (result as { data: ListingRecord[] }).data;
      }
      return [];
    } catch (error) {
      console.error('Recommendations error:', toMessage(error, 'unknown'));
      return [];
    }
  },
};
