import { bookingTools } from '../src/tools/bookings';

// Mock the backend REST client (SPLIT-226 / M4): booking tools now forward the
// caller's JWT to the backend instead of writing to Supabase/Stripe.
const mockBackendRequest = jest.fn();
jest.mock('../src/lib/backend-client', () => {
  class BackendApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'BackendApiError';
      this.status = status;
    }
  }
  return {
    BackendApiError,
    backendRequest: (...args: unknown[]) => mockBackendRequest(...args),
  };
});

const TOKEN = 'header.payload.sig';

function defaultBackend() {
  mockBackendRequest.mockImplementation(async (method: string, path: string) => {
    if (method === 'GET' && path.startsWith('/listings/')) return { pricePerDay: '50.00' };
    if (method === 'POST' && path === '/bookings') return { id: 'booking-1', status: 'pending', totalPrice: 100 };
    if (method === 'PUT' && /^\/bookings\/.+\/status$/.test(path)) return { id: 'booking-1', status: 'cancelled' };
    if (method === 'GET' && /^\/bookings\/.+$/.test(path)) return { id: 'booking-1', status: 'pending' };
    throw new Error(`unexpected request ${method} ${path}`);
  });
}

describe('Booking Tools (backend REST)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    defaultBackend();
  });

  it('creates a booking via POST /bookings with the forwarded token', async () => {
    const result = await bookingTools.createBooking({
      listingId: 'listing-1',
      checkIn: '2026-07-01',
      checkOut: '2026-07-03',
      token: TOKEN,
    });
    expect(result.success).toBe(true);
    expect(result.booking?.id).toBe('booking-1');
    // The POST carried the token and mapped checkIn/checkOut → startDate/endDate.
    const post = mockBackendRequest.mock.calls.find((c) => c[0] === 'POST' && c[1] === '/bookings');
    expect(post?.[2]).toMatchObject({ token: TOKEN });
    expect(post?.[2].body).toMatchObject({ listingId: 'listing-1', startDate: '2026-07-01', endDate: '2026-07-03' });
    // guests is NOT forwarded (backend whitelist would 400 on it).
    expect(post?.[2].body).not.toHaveProperty('guests');
  });

  it('requires a token to create a booking', async () => {
    const result = await bookingTools.createBooking({
      listingId: 'listing-1',
      checkIn: '2026-07-01',
      checkOut: '2026-07-03',
      token: '',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Authentication required/);
    expect(mockBackendRequest).not.toHaveBeenCalled();
  });

  it('surfaces the backend error message when booking creation fails', async () => {
    const { BackendApiError } = jest.requireMock('../src/lib/backend-client');
    mockBackendRequest.mockImplementation(async (method: string) => {
      if (method === 'GET') return { pricePerDay: '50.00' };
      throw new BackendApiError(400, 'totalPrice must be a positive number');
    });
    const result = await bookingTools.createBooking({
      listingId: 'listing-1',
      checkIn: '2026-07-01',
      checkOut: '2026-07-03',
      token: TOKEN,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('totalPrice must be a positive number');
  });

  it('cancels a booking via PUT /bookings/:id/status', async () => {
    const result = await bookingTools.cancelBooking('booking-1', TOKEN);
    expect(result.success).toBe(true);
    expect(mockBackendRequest).toHaveBeenCalledWith(
      'PUT',
      '/bookings/booking-1/status',
      expect.objectContaining({ token: TOKEN, body: { status: 'cancelled' } }),
    );
  });

  it('requires a token to cancel a booking', async () => {
    const result = await bookingTools.cancelBooking('booking-1', '');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Authentication required/);
  });

  it('fetches booking status via GET /bookings/:id with the token', async () => {
    const result = await bookingTools.getBookingStatus('booking-1', TOKEN);
    expect(result.success).toBe(true);
    expect(result.booking?.id).toBe('booking-1');
    expect(mockBackendRequest).toHaveBeenCalledWith('GET', '/bookings/booking-1', { token: TOKEN });
  });
});
