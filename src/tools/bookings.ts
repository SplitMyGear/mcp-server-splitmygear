import { backendRequest, BackendApiError } from '@/lib/backend-client';

/**
 * Booking tools call the SplitMyGear backend REST API (/api/v1) forwarding the
 * caller's JWT (SPLIT-226 / M4). The backend owns auth, RBAC, ownership checks,
 * server-authoritative pricing (SPLIT-157), risk scoring and payment — none of
 * which the previous direct Supabase+Stripe writes honoured (they also targeted
 * a column schema that diverged from the real `booking` entity).
 */

export interface BackendBooking {
  id: string;
  status?: string;
  totalPrice?: number | string;
  [key: string]: unknown;
}

const AUTH_REQUIRED =
  'Authentication required: call with a user Bearer token (obtained from POST /api/v1/users/login).';

function toMessage(error: unknown, fallback: string): string {
  return error instanceof BackendApiError ? error.message : fallback;
}

export const bookingTools = {
  async createBooking(data: {
    listingId: string;
    checkIn: string;
    checkOut: string;
    token: string;
  }): Promise<{ success: boolean; booking?: BackendBooking; error?: string }> {
    if (!data.token) return { success: false, error: AUTH_REQUIRED };
    try {
      // The backend recomputes the authoritative total (SPLIT-157) but its DTO
      // requires a positive totalPrice. Send a best-effort estimate from the
      // public listing; the response reflects the server's real price.
      let totalPrice = 1;
      try {
        const listing = await backendRequest<{ pricePerDay?: number | string }>(
          'GET',
          `/listings/${data.listingId}`,
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

      const booking = await backendRequest<BackendBooking>('POST', '/bookings', {
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
  ): Promise<{ success: boolean; booking?: BackendBooking; message?: string; error?: string }> {
    if (!token) return { success: false, error: AUTH_REQUIRED };
    try {
      // The backend enforces that only the renter/vendor may cancel and handles
      // any refund. Ownership is derived from the forwarded token, not a param.
      const booking = await backendRequest<BackendBooking>('PUT', `/bookings/${bookingId}/status`, {
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
  ): Promise<{ success: boolean; booking?: BackendBooking; error?: string }> {
    if (!token) return { success: false, error: AUTH_REQUIRED };
    try {
      // GET /bookings/:id is ownership-gated server-side (renter/vendor/admin).
      const booking = await backendRequest<BackendBooking>('GET', `/bookings/${bookingId}`, { token });
      return { success: true, booking };
    } catch (error) {
      return { success: false, error: toMessage(error, 'Failed to fetch booking') };
    }
  },
};
