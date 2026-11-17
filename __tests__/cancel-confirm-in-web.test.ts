/**
 * SPLIT-1924: cancelling a rental booking and declining a reschedule proposal
 * (which cancels and refunds) are completed in the web app. The tools make no
 * backend write and return a confirmUrl, the same rule SPLIT-1909 set for
 * accepting a charge or claim. Everything that is not final still calls the backend.
 */
export {};

const mockBackendRequest = jest.fn();
jest.mock('../src/lib/backend-client', () => {
  class BackendApiError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.name = 'BackendApiError'; this.status = status; }
  }
  return { BackendApiError, backendRequest: (...args: unknown[]) => mockBackendRequest(...args), backendBaseUrl: () => 'https://api.test/api/v1' };
});

import { cancelBooking, respondToRescheduleProposal, previewCancellation } from '../src/tools/defs/renter';
import { bookingConfirmUrl } from '../src/tools/confirm-in-web';

const T = 'h.p.s';
const B = '11111111-1111-4111-8111-111111111111';
const WEIRD = 'a/b?c=d&e#f';

function lastCall() {
  const c = mockBackendRequest.mock.calls[mockBackendRequest.mock.calls.length - 1];
  return { method: c[0], path: c[1], opts: c[2] ?? {} };
}
function payload(result: { content: Array<{ type: string; text?: string }> }) {
  return JSON.parse(result.content[0]?.text ?? '{}');
}

beforeEach(() => {
  mockBackendRequest.mockReset();
  mockBackendRequest.mockResolvedValue({ ok: 1 });
});

describe('cancel_booking hands back a link (SPLIT-1924)', () => {
  it('makes no backend call and points a renter at the role-aware bookings list', async () => {
    const result = await cancelBooking.handler({ bookingId: B }, { token: T, role: 'renter' });
    expect(mockBackendRequest).not.toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
    const body = payload(result);
    expect(body).toMatchObject({ requiresUserConfirmation: true, confirmUrl: `https://go-splitt.com/bookings?b=${B}` });
    expect(body.message).toMatch(/^Nothing was cancelled/);
    expect(body.message).toMatch(/preview_cancellation/);
  });

  it.each(['vendor', 'vendor_owner', 'vendor_manager', 'vendor_staff'])('points %s at the vendor bookings list, where cancel exists', async (role) => {
    const result = await cancelBooking.handler({ bookingId: B, reason: 'severe_weather' }, { token: T, role });
    expect(mockBackendRequest).not.toHaveBeenCalled();
    expect(payload(result)).toMatchObject({ requiresUserConfirmation: true, confirmUrl: `https://go-splitt.com/vendor/bookings?b=${B}` });
    expect(payload(result).message).toMatch(/^Nothing was cancelled/);
  });

  it('falls back to the renter list for an admin or an unknown role, and encodes the id', async () => {
    expect(payload(await cancelBooking.handler({ bookingId: B }, { token: T, role: 'admin' })).confirmUrl).toBe(`https://go-splitt.com/bookings?b=${B}`);
    expect(payload(await cancelBooking.handler({ bookingId: B }, { token: T })).confirmUrl).toBe(`https://go-splitt.com/bookings?b=${B}`);
    expect(bookingConfirmUrl('renter', WEIRD)).toBe(`https://go-splitt.com/bookings?b=${encodeURIComponent(WEIRD)}`);
    expect(bookingConfirmUrl('vendor', WEIRD)).toBe(`https://go-splitt.com/vendor/bookings?b=${encodeURIComponent(WEIRD)}`);
    expect(mockBackendRequest).not.toHaveBeenCalled();
  });

  it('is no longer marked as a destructive write', () => {
    expect(cancelBooking.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(cancelBooking.description).toMatch(/does NOT cancel anything/);
  });
});

describe('respond_to_reschedule_proposal (SPLIT-1924)', () => {
  it('routes decline (it cancels and refunds) to the renter list with no backend call, whatever the role', async () => {
    for (const role of ['renter', 'vendor', undefined]) {
      const result = await respondToRescheduleProposal.handler({ bookingId: B, action: 'decline' }, { token: T, role });
      expect(payload(result)).toMatchObject({ requiresUserConfirmation: true, confirmUrl: `https://go-splitt.com/bookings?b=${B}` });
      expect(payload(result).message).toMatch(/^Nothing was declined/);
    }
    expect(mockBackendRequest).not.toHaveBeenCalled();
  });

  it('encodes the id in the decline link', async () => {
    const result = await respondToRescheduleProposal.handler({ bookingId: WEIRD, action: 'decline' }, { token: T, role: 'renter' });
    expect(payload(result).confirmUrl).toBe(`https://go-splitt.com/bookings?b=${encodeURIComponent(WEIRD)}`);
  });

  it('still accepts a proposal through the backend', async () => {
    await respondToRescheduleProposal.handler({ bookingId: B, action: 'accept' }, { token: T, role: 'renter' });
    expect(lastCall()).toMatchObject({ method: 'POST', path: `/bookings/${B}/reschedule-proposal/accept`, opts: { token: T } });
  });
});

describe('unchanged paths still call the backend', () => {
  it('preview_cancellation reads the refund preview', async () => {
    await previewCancellation.handler({ bookingId: B }, { token: T, role: 'renter' });
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/bookings/${B}/cancellation-preview`, opts: { token: T } });
  });
});
