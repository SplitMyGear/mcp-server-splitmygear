/** Contract tests for the new tool backends: exact backend method/path/body/token per call. */
export {};

const mockBackendRequest = jest.fn();
jest.mock('../src/lib/backend-client', () => {
  class BackendApiError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.name = 'BackendApiError'; this.status = status; }
  }
  return { BackendApiError, backendRequest: (...args: unknown[]) => mockBackendRequest(...args) };
});

import { accountTools } from '../src/tools/account';
import { reviewTools } from '../src/tools/reviews';
import { favoriteTools } from '../src/tools/favorites';
import { vendorListingTools } from '../src/tools/vendor-listings';
import { vendorBookingTools } from '../src/tools/vendor-bookings';
import { vendorFinanceTools } from '../src/tools/vendor-finance';
import { bookingTools } from '../src/tools/bookings';
import { messagingTools } from '../src/tools/messaging';
import { experienceTools } from '../src/tools/experiences';
import { listingTools } from '../src/tools/listings';
import { call, compact, qs, dateRangeError } from '../src/tools/_shared';

const T = 'h.p.s';
const { BackendApiError } = jest.requireMock('../src/lib/backend-client');

function lastCall() {
  const c = mockBackendRequest.mock.calls[mockBackendRequest.mock.calls.length - 1];
  return { method: c[0], path: c[1], opts: c[2] ?? {} };
}

beforeEach(() => {
  mockBackendRequest.mockReset();
  mockBackendRequest.mockResolvedValue({ ok: 1 });
});

describe('_shared', () => {
  it('wraps backend errors into Result and validates ranges', async () => {
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(403, 'nope'));
    expect(await call('GET', '/x')).toEqual({ ok: false, error: 'nope', status: 403 });
    mockBackendRequest.mockRejectedValueOnce(new Error('net'));
    expect((await call('GET', '/x')).ok).toBe(false);
    expect(qs({ a: 1, b: undefined, c: '', d: 'x y' })).toBe('?a=1&d=x+y');
    expect(compact({ a: 1, b: undefined })).toEqual({ a: 1 });
    expect(dateRangeError('2026-07-01', '2026-07-03')).toBeNull();
    expect(dateRangeError('2026-07-03', '2026-07-01')).toMatch(/after/);
    expect(dateRangeError('nope', '2026-07-01')).toMatch(/Invalid startDate/);
    expect(dateRangeError('2026-01-01', '2027-06-01')).toMatch(/too long/);
  });
});

describe('accountTools', () => {
  it('reads and updates the profile with only the given fields', async () => {
    await accountTools.getMyProfile(T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/users/me', opts: { token: T } });
    await accountTools.updateMyProfile(T, { firstName: 'A', bio: undefined });
    expect(lastCall()).toMatchObject({ method: 'PUT', path: '/users/profile', opts: { token: T, body: { firstName: 'A' } } });
    expect(lastCall().opts.body).not.toHaveProperty('bio');
  });

  it('notifications + unread counts', async () => {
    await accountTools.listNotifications(T, 10, 5);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/notifications?limit=10&offset=5' });
    await accountTools.markNotificationRead(T, 'n1');
    expect(lastCall()).toMatchObject({ method: 'PUT', path: '/notifications/n1/read' });
    await accountTools.markAllNotificationsRead(T);
    expect(lastCall()).toMatchObject({ method: 'PUT', path: '/notifications/read-all' });
    mockBackendRequest.mockImplementation(async (_m: string, path: string) => {
      if (path === '/chat/unread-count') return { total: 3, perConversation: { c1: 3 } };
      if (path === '/notifications/unread-count') throw new BackendApiError(500, 'down');
      return {};
    });
    const counts = await accountTools.getUnreadCounts(T);
    expect(counts.unreadMessages).toBe(3);
    expect(counts.unreadNotifications).toBeNull();
    expect(counts.errors).toEqual(['notifications: down']);
  });
});

describe('reviewTools', () => {
  it('lists listing reviews with summary, and writes reviews/responses', async () => {
    mockBackendRequest.mockImplementation(async (_m: string, path: string) => (path.endsWith('/summary') ? { average: 4.5 } : [{ id: 'r1' }]));
    const res = await reviewTools.getListingReviews('l1');
    expect(res).toEqual({ ok: true, data: { summary: { average: 4.5 }, reviews: [{ id: 'r1' }] } });
    mockBackendRequest.mockResolvedValue({});
    await reviewTools.createReview(T, { type: 'listing', listingId: 'l1', rating: 5, comment: undefined });
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/reviews', opts: { token: T, body: { type: 'listing', listingId: 'l1', rating: 5 } } });
    await reviewTools.respondToReview(T, 'r1', 'Thanks!', 'update');
    expect(lastCall()).toMatchObject({ method: 'PUT', path: '/reviews/r1/response', opts: { body: { response: 'Thanks!' } } });
    await reviewTools.deleteReviewResponse(T, 'r1');
    expect(lastCall()).toMatchObject({ method: 'DELETE', path: '/reviews/r1/response' });
    await reviewTools.deleteReview(T, 'r1');
    expect(lastCall()).toMatchObject({ method: 'DELETE', path: '/reviews/r1' });
  });
});

describe('favoriteTools', () => {
  it('lists and toggles', async () => {
    await favoriteTools.list(T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/favorites' });
    await favoriteTools.toggle(T, 'l1');
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/favorites/toggle', opts: { body: { listingId: 'l1' } } });
  });
});

describe('bookingTools (new surface)', () => {
  it('quotes publicly, opens checkout, lists, previews, responds', async () => {
    await bookingTools.getQuote({ listingId: 'l1', startDate: '2026-07-01', endDate: '2026-07-03', quantity: undefined });
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/bookings/quote', opts: { body: { listingId: 'l1', startDate: '2026-07-01', endDate: '2026-07-03' } } });
    expect(lastCall().opts.token).toBeUndefined();
    await bookingTools.createCheckoutSession('b1', T);
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/payments/checkout-session', opts: { token: T, body: { bookingId: 'b1' } } });
    await bookingTools.setProtectionPlan('b1', 'standard', T);
    expect(lastCall()).toMatchObject({ method: 'PATCH', path: '/bookings/b1/protection', opts: { body: { plan: 'standard' } } });
    await bookingTools.listMyBookings(T, 20, 0);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/bookings/my-bookings?limit=20&offset=0' });
    await bookingTools.previewCancellation('b1', T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/bookings/b1/cancellation-preview' });
    await bookingTools.getHistory('b1', T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/bookings/b1/history' });
    await bookingTools.respondToRescheduleProposal('b1', 'decline', T);
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/bookings/b1/reschedule-proposal/decline' });
    await bookingTools.cancelBooking('b1', T, 'severe_weather');
    expect(lastCall()).toMatchObject({ method: 'PUT', path: '/bookings/b1/status', opts: { body: { status: 'cancelled', reason: 'severe_weather' } } });
  });

  it('creates a booking with a payment link and passes the extra DTO fields', async () => {
    mockBackendRequest.mockImplementation(async (method: string, path: string) => {
      if (path === '/bookings/quote') return { total: 250 };
      if (path === '/bookings') return { id: 'b9', status: 'draft' };
      if (path === '/payments/checkout-session') return { checkoutUrl: 'https://checkout.stripe.com/x' };
      throw new Error(`unexpected ${method} ${path}`);
    });
    const res = await bookingTools.createBooking({ listingId: 'l1', checkIn: '2026-07-01', checkOut: '2026-07-03', token: T, protectionPlan: 'basic', quantity: 2, withPaymentLink: true });
    expect(res).toMatchObject({ success: true, paymentUrl: 'https://checkout.stripe.com/x', quote: { total: 250 } });
    const post = mockBackendRequest.mock.calls.find((c) => c[1] === '/bookings');
    expect(post?.[2].body).toEqual({ listingId: 'l1', startDate: '2026-07-01', endDate: '2026-07-03', totalPrice: 250, protectionPlan: 'basic', quantity: 2 });
  });

  it('surfaces a failed checkout without losing the created booking', async () => {
    mockBackendRequest.mockImplementation(async (_m: string, path: string) => {
      if (path === '/bookings/quote') throw new BackendApiError(404, 'no listing');
      if (path === '/bookings') return { id: 'b9' };
      if (path === '/payments/checkout-session') throw new BackendApiError(409, 'not payable');
      return {};
    });
    const res = await bookingTools.createBooking({ listingId: 'l1', checkIn: '2026-07-01', checkOut: '2026-07-03', token: T, withPaymentLink: true });
    expect(res).toMatchObject({ success: true, paymentError: 'not payable' });
    const post = mockBackendRequest.mock.calls.find((c) => c[1] === '/bookings');
    expect(post?.[2].body.totalPrice).toBe(1); // nominal fallback when the quote failed
  });
});

describe('messagingTools (new surface)', () => {
  it('reads messages, marks read, passes conversation context on create', async () => {
    await messagingTools.getMessages('c1', T, '2026-01-01T00:00:00Z');
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/chat/conversations/c1/messages?since=2026-01-01T00%3A00%3A00Z', opts: { token: T } });
    await messagingTools.markConversationRead('c1', T);
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/chat/conversations/c1/read' });
    mockBackendRequest.mockImplementation(async (method: string, path: string) => {
      if (path === '/chat/conversations') return { id: 'c2' };
      if (path === '/chat/conversations/c2/messages') return { id: 'm1' };
      throw new Error(`unexpected ${method} ${path}`);
    });
    const res = await messagingTools.sendMessage({ recipientId: '11111111-1111-4111-8111-111111111111', content: 'hi', listingId: 'l1', token: T });
    expect(res).toMatchObject({ success: true, conversationId: 'c2' });
    const create = mockBackendRequest.mock.calls.find((c) => c[1] === '/chat/conversations');
    expect(create?.[2].body).toEqual({ participantId: '11111111-1111-4111-8111-111111111111', listingId: 'l1' });
  });
});

describe('experienceTools (new surface)', () => {
  it('books with a payment link and manages hosting', async () => {
    mockBackendRequest.mockImplementation(async (_m: string, path: string) => {
      if (path === '/packages/bookings') return { success: true, booking: { id: 'eb1' } };
      if (path === '/packages/bookings/eb1/checkout-session') return { checkoutUrl: 'https://checkout.stripe.com/e' };
      return {};
    });
    const res = await experienceTools.bookExperience({ experienceId: 'e1', guests: 2, children: 1, withPaymentLink: true, token: T });
    expect(res).toMatchObject({ success: true, bookingId: 'eb1', paymentUrl: 'https://checkout.stripe.com/e' });
    const post = mockBackendRequest.mock.calls.find((c) => c[1] === '/packages/bookings');
    expect(post?.[2].body).toEqual({ experienceId: 'e1', numberOfGuests: 2, numberOfChildren: 1 });
    mockBackendRequest.mockResolvedValue({});
    await experienceTools.listMyExperienceBookings(T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/packages/bookings/my' });
    await experienceTools.transitionExperienceBooking('eb1', 'complete', T);
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/packages/bookings/eb1/complete' });
    await experienceTools.createExperience(T, { title: 't', description: 'd', duration: 2, durationUnit: 'hours', pricePerPerson: 50 });
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/packages', opts: { body: { title: 't', duration: 2, durationUnit: 'hours', pricePerPerson: 50 } } });
    await experienceTools.setExperienceStatus('e1', 'publish', T);
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/packages/e1/publish' });
    await experienceTools.addSchedule('e1', T, { date: '2026-07-01', startTime: '09:00' });
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/packages/e1/schedules', opts: { body: { date: '2026-07-01', startTime: '09:00' } } });
    await experienceTools.deleteSchedule('e1', 's1', T);
    expect(lastCall()).toMatchObject({ method: 'DELETE', path: '/packages/e1/schedules/s1' });
    await experienceTools.listHostBookings(T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/packages/host/bookings' });
  });
});

describe('vendorListingTools', () => {
  it('maps every listing operation to the canonical /rentals routes', async () => {
    await vendorListingTools.listMyListings(T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/rentals/my-listings', opts: { token: T } });
    await vendorListingTools.createListing(T, { name: 'Tent', description: 'd', pricePerDay: 20, category: 'Camping', imageUrls: undefined });
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/rentals', opts: { body: { name: 'Tent', description: 'd', pricePerDay: 20, category: 'Camping' } } });
    expect(lastCall().opts.body).not.toHaveProperty('imageUrls');
    await vendorListingTools.updateListing('l1', T, { pricePerDay: 25 });
    expect(lastCall()).toMatchObject({ method: 'PUT', path: '/rentals/l1', opts: { body: { pricePerDay: 25 } } });
    await vendorListingTools.setPublished('l1', true, T);
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/rentals/l1/publish' });
    await vendorListingTools.setPublished('l1', false, T);
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/rentals/l1/unpublish' });
    await vendorListingTools.deleteListing('l1', T);
    expect(lastCall()).toMatchObject({ method: 'DELETE', path: '/rentals/l1' });
    await vendorListingTools.duplicateListing('l1', T);
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/rentals/l1/duplicate' });
    await vendorListingTools.generateListingDraft(T, { gearType: 'tent', features: ['light'] });
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/ai/generate-listing', opts: { body: { gearType: 'tent', features: ['light'] } } });
    await vendorListingTools.getListingPerformance(T, '2026-01-01', undefined);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/analytics/listings/performance?startDate=2026-01-01' });
    await vendorListingTools.listBlackoutDates('l1', T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/rentals/l1/blackout-dates' });
    await vendorListingTools.addBlackoutDates('l1', T, { startDate: '2026-07-01', endDate: '2026-07-02' });
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/rentals/l1/blackout-dates', opts: { body: { startDate: '2026-07-01', endDate: '2026-07-02' } } });
    await vendorListingTools.removeBlackoutDate('bd1', T);
    expect(lastCall()).toMatchObject({ method: 'DELETE', path: '/blackout-dates/bd1' });
  });
});

describe('vendorBookingTools', () => {
  it('maps incoming-booking operations', async () => {
    await vendorBookingTools.listIncomingBookings(T, 50, 0);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/bookings/for-my-listings?limit=50&offset=0' });
    await vendorBookingTools.setReturnStatus('b1', false, T, 'late');
    expect(lastCall()).toMatchObject({ method: 'PUT', path: '/bookings/b1/mark-not-returned', opts: { body: { note: 'late' } } });
    await vendorBookingTools.setReturnStatus('b1', true, T);
    expect(lastCall()).toMatchObject({ method: 'PUT', path: '/bookings/b1/mark-returned' });
    await vendorBookingTools.proposeReschedule('b1', T, { startDate: '2026-07-05', endDate: '2026-07-07' });
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/bookings/b1/reschedule-proposal', opts: { body: { startDate: '2026-07-05', endDate: '2026-07-07' } } });
    await vendorBookingTools.withdrawReschedule('b1', T);
    expect(lastCall()).toMatchObject({ method: 'DELETE', path: '/bookings/b1/reschedule-proposal' });
    await vendorBookingTools.setVendorNotes('b1', T, null);
    expect(lastCall()).toMatchObject({ method: 'PATCH', path: '/bookings/b1/vendor-notes', opts: { body: { vendorNotes: null } } });
  });
});

describe('vendorFinanceTools', () => {
  it('reads earnings, payouts (merged), Stripe status and dashboard', async () => {
    await vendorFinanceTools.getEarnings(T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/vendor/earnings' });
    mockBackendRequest.mockImplementation(async (_m: string, path: string) => {
      if (path === '/vendor/payouts') return { payouts: [1] };
      if (path === '/vendor/upcoming-payouts') throw new BackendApiError(500, 'x');
      if (path === '/analytics/dashboard') return { revenue: 10 };
      if (path.startsWith('/analytics/revenue')) return [1, 2];
      if (path === '/vendor/stripe-connect/onboard') return { url: 'https://connect.stripe.com/setup' };
      return {};
    });
    expect(await vendorFinanceTools.getPayouts(T)).toEqual({ ok: true, data: { payouts: { payouts: [1] }, upcoming: null, errors: ['upcoming: x'] } });
    expect(await vendorFinanceTools.getDashboard(T, '2026-01-01', '2026-02-01')).toEqual({ ok: true, data: { dashboard: { revenue: 10 }, revenue: [1, 2] } });
    expect(mockBackendRequest.mock.calls.find((c) => c[1].startsWith('/analytics/revenue'))?.[1]).toBe('/analytics/revenue?startDate=2026-01-01&endDate=2026-02-01');
    expect(await vendorFinanceTools.startStripeConnectOnboarding(T)).toEqual({ ok: true, data: { url: 'https://connect.stripe.com/setup' } });
  });
});

describe('listingTools (new surface)', () => {
  it('forwards a token to the listing detail and reads the calendar', async () => {
    await listingTools.getListingDetails('l1', T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/rentals/l1', opts: { token: T } });
    await listingTools.getAvailabilityCalendar('l1', '2026-07-01', '2026-07-31');
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/rentals/l1/availability/calendar?from=2026-07-01&to=2026-07-31' });
  });
});
