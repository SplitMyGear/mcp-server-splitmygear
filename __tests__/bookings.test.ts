import { bookingTools } from '../src/tools/bookings';
import { supabase } from '../src/lib/supabase';

const mockListings = [{ id: 'listing-1', title: 'Test', pricePerDay: 50, maxGuests: 4 }];
const mockBookings = [{ id: 'booking-1', userId: 'user-1', listingId: 'listing-1', status: 'confirmed', paymentIntentId: 'pi_1' }];

const createMockBuilder = (data: any[]): any => ({
  select: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  in: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  limit: jest.fn().mockResolvedValue({ data, error: null }),
  single: jest.fn().mockImplementation(() => ({ 
    data: data[0] || null, 
    error: data.length === 0 ? { message: 'Not found' } : null 
  })),
  insert: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  then: jest.fn().mockImplementation((cb) => Promise.resolve(cb({ data, error: null }))),
});

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: jest.fn((table: string) => {
      if (table === 'listing') return createMockBuilder(mockListings);
      if (table === 'booking') return createMockBuilder(mockBookings);
      return createMockBuilder([]);
    }),
  },
}));

jest.mock('stripe', () => jest.fn().mockImplementation(() => ({
  paymentIntents: { create: jest.fn().mockResolvedValue({ id: 'pi_new', client_secret: 'secret' }) },
  refunds: { create: jest.fn().mockResolvedValue({ id: 'ref_1' }) },
})));

describe('Booking Tools Exhaustive', () => {
  it('should create booking', async () => {
    const result = await bookingTools.createBooking({
      listingId: 'listing-1', checkIn: '2024-01-01', checkOut: '2024-01-02', guests: 2, userId: 'u1'
    });
    expect(result.success).toBe(true);
  });

  it('should fail if listing not found', async () => {
    (supabase.from as jest.Mock).mockImplementationOnce(() => createMockBuilder([]));
    const result = await bookingTools.createBooking({
      listingId: 'none', checkIn: '2024-01-01', checkOut: '2024-01-02', guests: 2, userId: 'u1'
    });
    expect(result.success).toBe(false);
  });

  it('should cancel booking', async () => {
    const result = await bookingTools.cancelBooking('booking-1', 'user-1');
    expect(result.success).toBe(true);
  });
});
