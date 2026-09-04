/**
 * Vendor listing management — thin clients of the `/rentals` (== `/listings`)
 * vendor routes. The backend's VendorOrPrivilegedGuard enforces ownership.
 * Only fields from `CreateListingDto` are ever sent (the backend's global
 * ValidationPipe rejects undeclared fields with a 400).
 */
import { call, compact, qs } from './_shared';

export interface ListingInput {
  name: string;
  description: string;
  category?: string;
  pricePerDay?: number;
  pricePerHour?: number;
  bookingType?: 'daily' | 'hourly';
  location?: string;
  address?: string;
  generalArea?: string;
  latitude?: number;
  longitude?: number;
  imageUrls?: string[];
  make?: string;
  model?: string;
  year?: number;
  maxGuests?: number;
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
    return call('POST', '/rentals', { token, body: compact(input) });
  },

  updateListing(listingId: string, token: string, input: Partial<ListingInput>) {
    return call('PUT', `/rentals/${listingId}`, { token, body: compact(input) });
  },

  setPublished(listingId: string, published: boolean, token: string) {
    return call('POST', `/rentals/${listingId}/${published ? 'publish' : 'unpublish'}`, { token, body: {} });
  },

  deleteListing(listingId: string, token: string) {
    return call('DELETE', `/rentals/${listingId}`, { token });
  },

  duplicateListing(listingId: string, token: string) {
    return call('POST', `/rentals/${listingId}/duplicate`, { token, body: {} });
  },

  /** AI-drafted listing (title/description/specs/price guidance) from a gear description. */
  generateListingDraft(
    token: string,
    input: { gearType: string; brand?: string; model?: string; year?: number; location?: string; features?: string[]; vendorNotes?: string },
  ) {
    return call('POST', '/ai/generate-listing', { token, body: compact(input) });
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
