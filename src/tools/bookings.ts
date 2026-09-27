import { backendRequest, BackendApiError } from '@/lib/backend-client';
import type { GetResponse, PostResponse, PutResponse } from '@/lib/api-contract';
import { call, compact, qs, type Result } from './_shared';

/**
 * Booking tools call the SplitMyGear backend REST API (/api/v1) forwarding the
 * caller's JWT (SPLIT-226 / M4). The backend owns auth, RBAC, ownership checks,
 * server-authoritative pricing (SPLIT-157), risk scoring and payment.
 *
 * SPLIT-197 §C-MCP: booking response types are now derived from the backend's
 * OpenAPI contract (`@/lib/api-contract`) instead of the old hand-rolled
 * `BackendBooking` interface, so the tool layer type-checks against the real
 * `Booking` / `BookingResponseDto` schemas and stops drifting silently.
 */

/** POST /bookings returns the created `Booking` (spec-bound response). */
type CreatedBooking = PostResponse<'/api/v1/bookings'>;
/** GET /bookings/{id} returns a `BookingResponseDto` (spec-bound response). */
type FetchedBooking = GetResponse<'/api/v1/bookings/{id}'>;
/** PUT /bookings/{id}/status returns the updated booking (spec-bound, 200). */
type UpdatedBooking = PutResponse<'/api/v1/bookings/{id}/status'>;

const AUTH_REQUIRED =
  'Authentication required: call with a user Bearer token (obtained from POST /api/v1/users/login).';

/** Upper bound on a single rental window. Anything longer is almost certainly a
 *  caller mistake (e.g. swapped year), so we reject it client-side with a clear
 *  message rather than sending a nonsensical estimate to the backend. */
const MAX_RENTAL_DAYS = 365;

function toMessage(error: unknown, fallback: string): string {
  return error instanceof BackendApiError ? error.message : fallback;
}

/**
 * SPLIT-1503. A booking made through create_booking starts as a DRAFT: an
 * unpaid checkout. The backend lets no person move a draft anywhere (its
 * lifecycle table gives draft → cancelled to the system alone) and releases
 * unpaid drafts itself after DRAFT_EXPIRY_MINUTES (60 by default). Its refusal
 * reads "Only the listing vendor can set a booking to 'cancelled'", which is
 * wrong for a draft (the vendor cannot either) and sent callers looking for a
 * vendor. Say what is actually true instead.
 */
const DRAFT_NOT_CANCELLABLE =
  'This booking is an unpaid checkout (status "draft"), so there is nothing to cancel: no payment has been taken and ' +
  'Splitt releases unpaid checkouts automatically, usually within an hour. To keep the booking, pay with get_payment_link instead.';

/** Is this booking a draft? Asked only after a refused cancel; any failure here reads as "no". */
async function isUnpaidDraft(bookingId: string, token: string): Promise<boolean> {
  try {
    const booking = await backendRequest<{ status?: unknown }>('GET', `/bookings/${bookingId}`, { token });
    return booking?.status === 'draft';
  } catch {
    return false;
  }
}

/**
 * Client-side date hygiene before hitting the backend: ensures both dates parse
 * and that checkOut is strictly after checkIn within a sane window. Returns a
 * human-readable error string when invalid, or null when the dates are usable.
 * This gives the caller a clear 400-style message instead of a confusing
 * backend error derived from a clamped/garbage estimate (the backend remains
 * the authority and re-validates).
 */
function validateBookingDates(checkIn: string, checkOut: string): string | null {
  const start = new Date(checkIn).getTime();
  const end = new Date(checkOut).getTime();
  if (Number.isNaN(start)) return `Invalid checkIn date: "${checkIn}". Use an ISO date (e.g. 2026-07-01).`;
  if (Number.isNaN(end)) return `Invalid checkOut date: "${checkOut}". Use an ISO date (e.g. 2026-07-03).`;
  if (end <= start) return 'checkOut must be after checkIn.';
  if (end - start > MAX_RENTAL_DAYS * 86_400_000) {
    return `Rental window too long (max ${MAX_RENTAL_DAYS} days).`;
  }
  return null;
}

export const bookingTools = {
  /**
   * Create a rental booking. The backend re-prices authoritatively (SPLIT-157),
   * but its DTO requires a positive `totalPrice`, so we first ask
   * `POST /bookings/quote` — the same server-side pricing the checkout page
   * shows — and send that total (falling back to a nominal value if the quote
   * fails; an invalid listing surfaces from the POST). The booking is a DRAFT
   * until paid, so when `withPaymentLink` is set we also open a Stripe
   * Checkout session and return its URL for the renter to complete payment.
   */
  async createBooking(data: {
    listingId: string;
    checkIn: string;
    checkOut: string;
    token: string;
    protectionPlan?: 'none' | 'basic' | 'standard' | 'premier';
    quantity?: number;
    numberOfGuests?: number;
    selectedAddOns?: Array<{ name: string; quantity: number }>;
    deliveryRequested?: boolean;
    promoCode?: string;
    bringingPets?: boolean;
    withPaymentLink?: boolean;
  }): Promise<{ success: boolean; booking?: CreatedBooking; quote?: unknown; paymentUrl?: string; paymentError?: string; error?: string }> {
    if (!data.token) return { success: false, error: AUTH_REQUIRED };
    const dateError = validateBookingDates(data.checkIn, data.checkOut);
    if (dateError) return { success: false, error: dateError };
    try {
      let totalPrice = 1;
      let quote: unknown;
      // Three sequential backend calls must fit the function's 30 s budget:
      // quote 8 s + create 12 s + checkout 8 s.
      const quoteResult = await this.getQuote({
        listingId: data.listingId,
        startDate: data.checkIn,
        endDate: data.checkOut,
        quantity: data.quantity,
        numberOfGuests: data.numberOfGuests,
        protectionPlan: data.protectionPlan,
        selectedAddOns: data.selectedAddOns,
        deliveryRequested: data.deliveryRequested,
        bringingPets: data.bringingPets,
      }, 8_000);
      if (quoteResult.ok) {
        quote = quoteResult.data;
        const total = Number((quoteResult.data as { total?: unknown })?.total);
        if (Number.isFinite(total) && total > 0) totalPrice = Math.round(total * 100) / 100;
      }

      const booking = await backendRequest<CreatedBooking>('POST', '/bookings', {
        token: data.token,
        timeoutMs: 12_000,
        body: compact({
          listingId: data.listingId,
          startDate: data.checkIn,
          endDate: data.checkOut,
          totalPrice,
          protectionPlan: data.protectionPlan,
          quantity: data.quantity,
          numberOfGuests: data.numberOfGuests,
          selectedAddOns: data.selectedAddOns,
          deliveryRequested: data.deliveryRequested,
          promoCode: data.promoCode,
          bringingPets: data.bringingPets,
        }),
      });

      if (!data.withPaymentLink) return { success: true, booking, quote };
      const bookingId = (booking as { id?: string })?.id;
      if (!bookingId) return { success: true, booking, quote, paymentError: 'Booking created but no id was returned; cannot open checkout.' };
      const checkout = await this.createCheckoutSession(bookingId, data.token, 8_000);
      return checkout.ok
        ? { success: true, booking, quote, paymentUrl: checkout.data.checkoutUrl }
        : { success: true, booking, quote, paymentError: checkout.error };
    } catch (error) {
      return { success: false, error: toMessage(error, 'Failed to create booking') };
    }
  },

  /** Public, server-authoritative price breakdown (no booking is created). */
  getQuote(input: {
    listingId: string;
    startDate: string;
    endDate: string;
    quantity?: number;
    numberOfGuests?: number;
    protectionPlan?: string;
    selectedAddOns?: Array<{ name: string; quantity: number }>;
    deliveryRequested?: boolean;
    bringingPets?: boolean;
  }, timeoutMs?: number): Promise<Result<unknown>> {
    return call('POST', '/bookings/quote', { body: compact(input), timeoutMs });
  },

  /** Stripe Checkout for a DRAFT booking; the backend picks its own return URLs. */
  createCheckoutSession(bookingId: string, token: string, timeoutMs?: number): Promise<Result<{ checkoutUrl?: string; sessionId?: string }>> {
    return call('POST', '/payments/checkout-session', { token, body: { bookingId }, timeoutMs });
  },

  setProtectionPlan(bookingId: string, plan: 'none' | 'basic' | 'standard' | 'premier', token: string) {
    return call('PATCH', `/bookings/${bookingId}/protection`, { token, body: { plan } });
  },

  listMyBookings(token: string, limit = 50, offset = 0) {
    return call<FetchedBooking[]>('GET', `/bookings/my-bookings${qs({ limit, offset })}`, { token });
  },

  getHistory(bookingId: string, token: string) {
    return call('GET', `/bookings/${bookingId}/history`, { token });
  },

  previewCancellation(bookingId: string, token: string) {
    return call('GET', `/bookings/${bookingId}/cancellation-preview`, { token });
  },

  respondToRescheduleProposal(bookingId: string, action: 'accept' | 'decline', token: string) {
    return call('POST', `/bookings/${bookingId}/reschedule-proposal/${action}`, { token, body: {} });
  },

  async cancelBooking(
    bookingId: string,
    token: string,
    reason?: 'severe_weather',
  ): Promise<{ success: boolean; booking?: UpdatedBooking; message?: string; error?: string }> {
    if (!token) return { success: false, error: AUTH_REQUIRED };
    try {
      // The backend decides who may cancel and handles any refund: the renter
      // or the listing's vendor may cancel a PENDING or CONFIRMED booking.
      // Ownership is derived from the forwarded token, not a param. `reason`
      // is vendor/admin-only on the backend (a renter self-tag → 403).
      const booking = await backendRequest<UpdatedBooking>('PUT', `/bookings/${bookingId}/status`, {
        token,
        body: compact({ status: 'cancelled', reason }),
      });
      return { success: true, booking, message: 'Booking cancelled successfully' };
    } catch (error) {
      if (error instanceof BackendApiError && error.status === 403 && (await isUnpaidDraft(bookingId, token))) {
        return { success: false, error: DRAFT_NOT_CANCELLABLE };
      }
      return { success: false, error: toMessage(error, 'Failed to cancel booking') };
    }
  },

  async getBookingStatus(
    bookingId: string,
    token: string,
  ): Promise<{ success: boolean; booking?: FetchedBooking; error?: string }> {
    if (!token) return { success: false, error: AUTH_REQUIRED };
    try {
      // GET /bookings/:id is ownership-gated server-side (renter/vendor/admin).
      const booking = await backendRequest<FetchedBooking>('GET', `/bookings/${bookingId}`, { token });
      return { success: true, booking };
    } catch (error) {
      return { success: false, error: toMessage(error, 'Failed to fetch booking') };
    }
  },
};
