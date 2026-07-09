import { backendRequest, BackendApiError } from '@/lib/backend-client';
import type { GetResponse, PostResponse, BookingResponseDto } from '@/lib/api-contract';

/**
 * Booking tools call the SplitMyGear backend REST API (/api/v1) forwarding the
 * caller's JWT (SPLIT-226 / M4). The backend owns auth, RBAC, ownership checks,
 * server-authoritative pricing (SPLIT-157), risk scoring and payment — none of
 * which the previous direct Supabase+Stripe writes honoured (they also targeted
 * a column schema that diverged from the real `booking` entity).
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
/**
 * PUT /bookings/{id}/status returns the updated booking, but the backend
 * declares only a bare `object` response for that route (SPLIT-197 contract
 * gap — no `@ApiResponse` schema), so we type it as the known real shape,
 * `BookingResponseDto`, rather than the useless generated `Record<string, never>`.
 */
type UpdatedBooking = BookingResponseDto;

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
  async createBooking(data: {
    listingId: string;
    checkIn: string;
    checkOut: string;
    token: string;
  }): Promise<{ success: boolean; booking?: CreatedBooking; error?: string }> {
    if (!data.token) return { success: false, error: AUTH_REQUIRED };
    const dateError = validateBookingDates(data.checkIn, data.checkOut);
    if (dateError) return { success: false, error: dateError };
    try {
      // The backend recomputes the authoritative total (SPLIT-157) but its DTO
      // requires a positive totalPrice. Send a best-effort estimate from the
      // public listing; the response reflects the server's real price.
      let totalPrice = 1;
      try {
        const listing = await backendRequest<{ pricePerDay?: number | string }>(
          'GET',
          // SPLIT-220: canonical `/rentals` alias (byte-identical to `/listings`,
          // `@Controller(['listings', 'rentals'])`); the `/bookings` mutation
          // path below is a different controller and stays as-is.
          `/rentals/${data.listingId}`,
        );
        const perDay = parseFloat(String(listing?.pricePerDay ?? '0')) || 0;
        const days = Math.max(
          1,
          Math.ceil((new Date(data.checkOut).getTime() - new Date(data.checkIn).getTime()) / 86_400_000),
        );
        if (perDay > 0) totalPrice = Math.round(perDay * days * 100) / 100;
      } catch {
        // Listing lookup failed — fall back to a nominal value; the server
        // recomputes regardless, and an invalid listingId surfaces below.
      }

      const booking = await backendRequest<CreatedBooking>('POST', '/bookings', {
        token: data.token,
        body: {
          listingId: data.listingId,
          startDate: data.checkIn,
          endDate: data.checkOut,
          totalPrice,
        },
      });
      return { success: true, booking };
    } catch (error) {
      return { success: false, error: toMessage(error, 'Failed to create booking') };
    }
  },

  async cancelBooking(
    bookingId: string,
    token: string,
  ): Promise<{ success: boolean; booking?: UpdatedBooking; message?: string; error?: string }> {
    if (!token) return { success: false, error: AUTH_REQUIRED };
    try {
      // The backend enforces that only the renter/vendor may cancel and handles
      // any refund. Ownership is derived from the forwarded token, not a param.
      const booking = await backendRequest<UpdatedBooking>('PUT', `/bookings/${bookingId}/status`, {
        token,
        body: { status: 'cancelled' },
      });
      return { success: true, booking, message: 'Booking cancelled successfully' };
    } catch (error) {
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
