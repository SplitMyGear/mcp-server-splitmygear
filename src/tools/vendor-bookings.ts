/** Vendor-side booking operations on the caller's own listings. */
import { call, compact, qs } from './_shared';

export const vendorBookingTools = {
  listIncomingBookings(token: string, limit = 50, offset = 0) {
    return call<unknown[]>('GET', `/bookings/for-my-listings${qs({ limit, offset })}`, { token });
  },

  /** `returned=false` flags an overdue rental; `returned=true` clears it. */
  setReturnStatus(bookingId: string, returned: boolean, token: string, note?: string) {
    return returned
      ? call('PUT', `/bookings/${bookingId}/mark-returned`, { token, body: {} })
      : call('PUT', `/bookings/${bookingId}/mark-not-returned`, { token, body: compact({ note }) });
  },

  proposeReschedule(bookingId: string, token: string, input: { startDate: string; endDate: string; note?: string }) {
    return call('POST', `/bookings/${bookingId}/reschedule-proposal`, { token, body: compact(input) });
  },

  withdrawReschedule(bookingId: string, token: string) {
    return call('DELETE', `/bookings/${bookingId}/reschedule-proposal`, { token });
  },

  setVendorNotes(bookingId: string, token: string, vendorNotes: string | null) {
    return call('PATCH', `/bookings/${bookingId}/vendor-notes`, { token, body: { vendorNotes } });
  },
};
