/**
 * Vendor listing management — thin clients of the `/rentals` (== `/listings`)
 * vendor routes. The backend's VendorOrPrivilegedGuard enforces ownership.
 * Only fields from `CreateListingDto` are ever sent (the backend's global
 * ValidationPipe rejects undeclared fields with a 400).
 */
import { AI_GENERATION_TIMEOUT_MS, LISTING_WRITE_TIMEOUT_MS } from '@/lib/timeouts';
import { call, compact, qs } from './_shared';

export interface ListingInput {
  name: string;
  description: string;
  category?: string;
  pricePerDay?: number;
  pricePerHour?: number;
  bookingType?: 'daily' | 'hourly' | 'both' | 'nightly';
  location?: string;
  latitude?: number;
  longitude?: number;
  imageUrls?: string[];
  make?: string;
  model?: string;
  year?: number;
  maxGuests?: number;
  checkInTime?: string;
  checkOutTime?: string;
  instantBook?: boolean;
  requiresIdVerification?: boolean;
  cancellationPolicy?: 'flexible' | 'flexible_72h' | 'moderate' | 'strict' | 'non_refundable';
  depositAmount?: number;
  deliveryAvailable?: boolean;
  deliveryFee?: number;
  deliveryRadiusMiles?: number;
  leadTimeDays?: number;
  bufferDays?: number;
  minRentalDays?: number;
  maxRentalDays?: number;
  minAge?: number;
  estimatedValue?: number;
  weeklyDiscountPct?: number;
  monthlyDiscountPct?: number;
  quantity?: number;
  attributes?: Record<string, unknown>;
}

export const vendorListingTools = {
  listMyListings(token: string) {
    return call('GET', '/rentals/my-listings', { token });
  },

  createListing(token: string, input: ListingInput) {
    return call('POST', '/rentals', { token, body: compact(input), timeoutMs: LISTING_WRITE_TIMEOUT_MS });
  },

  updateListing(listingId: string, token: string, input: Partial<ListingInput>) {
    return call('PUT', `/rentals/${listingId}`, { token, body: compact(input), timeoutMs: LISTING_WRITE_TIMEOUT_MS });
  },

  setPublished(listingId: string, published: boolean, token: string) {
    // Publishing indexes a listing that has no search embedding yet (AI), like a create.
    return call('POST', `/rentals/${listingId}/${published ? 'publish' : 'unpublish'}`, { token, body: {}, timeoutMs: LISTING_WRITE_TIMEOUT_MS });
  },

  /** The web app's own archive path (the bulk toolbar); there is no single-listing route. */
  archiveListing(listingId: string, token: string) {
    return call('POST', '/rentals/bulk/status', { token, body: { listingIds: [listingId], status: 'archived' } });
  },

  deleteListing(listingId: string, token: string) {
    return call('DELETE', `/rentals/${listingId}`, { token });
  },

  duplicateListing(listingId: string, token: string) {
    return call('POST', `/rentals/${listingId}/duplicate`, { token, body: {}, timeoutMs: LISTING_WRITE_TIMEOUT_MS });
  },

  /** AI-drafted listing (title/description/specs/price guidance) from a gear description. */
  generateListingDraft(
    token: string,
    input: { gearType: string; brand?: string; model?: string; year?: number; location?: string; features?: string[]; vendorNotes?: string },
  ) {
    return call('POST', '/ai/generate-listing', { token, body: compact(input), timeoutMs: AI_GENERATION_TIMEOUT_MS });
  },

  getListingPerformance(token: string, startDate?: string, endDate?: string) {
    return call('GET', `/analytics/listings/performance${qs({ startDate, endDate })}`, { token });
  },

  // ── Blackout dates ───────────────────────────────────────────────────────

  listBlackoutDates(listingId: string, token: string) {
    return call('GET', `/rentals/${listingId}/blackout-dates`, { token });
  },

  addBlackoutDates(listingId: string, token: string, input: { startDate: string; endDate: string; reason?: string }) {
    return call('POST', `/rentals/${listingId}/blackout-dates`, { token, body: compact(input) });
  },

  removeBlackoutDate(blackoutId: string, token: string) {
    return call('DELETE', `/blackout-dates/${blackoutId}`, { token });
  },
};
