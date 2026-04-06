import { supabase, Booking } from '@/lib/supabase';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2023-10-16',
});

interface CreateBookingData {
  listingId: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  userId: string;
}

export const bookingTools = {
  async createBooking(data: CreateBookingData): Promise<{ success: boolean; booking?: Booking; error?: string }> {
    try {
      const { data: listing, error: listingError } = await supabase
        .from('listing')
        .select('pricePerDay, vendorId')
        .eq('id', data.listingId)
        .single();

      if (listingError || !listing) {
        return { success: false, error: 'Listing not found' };
      }

      const checkIn = new Date(data.checkIn);
      const checkOut = new Date(data.checkOut);
      const days = Math.ceil((checkOut.getTime() - checkIn.getTime()) / (1000 * 60 * 60 * 24));
      const totalPrice = listing.pricePerDay * days;

      const { data: booking, error } = await supabase
        .from('booking')
        .insert({
          listingId: data.listingId,
          userId: data.userId,
          checkIn: data.checkIn,
          checkOut: data.checkOut,
          guests: data.guests,
          totalPrice,
          status: 'pending',
        })
        .select()
        .single();

      if (error) {
        return { success: false, error: error.message };
      }

      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(totalPrice * 100),
        currency: 'usd',
        metadata: {
          bookingId: booking.id,
          userId: data.userId,
        },
      });

      await supabase
        .from('booking')
        .update({ paymentIntentId: paymentIntent.id })
        .eq('id', booking.id);

      return {
        success: true,
        booking: {
          ...booking,
          clientSecret: paymentIntent.client_secret,
        },
      };
    } catch (error) {
      console.error('Create booking error:', error);
      return { success: false, error: 'Failed to create booking' };
    }
  },

  async cancelBooking(
    bookingId: string,
    userId: string,
    reason?: string
  ): Promise<{ success: boolean; message?: string; error?: string }> {
    try {
      const { data: booking, error } = await supabase
        .from('booking')
        .select('*')
        .eq('id', bookingId)
        .single();

      if (error || !booking) {
        return { success: false, error: 'Booking not found' };
      }

      if (booking.userId !== userId) {
        return { success: false, error: 'Unauthorized' };
      }

      if (booking.status === 'cancelled') {
        return { success: false, error: 'Booking already cancelled' };
      }

      await supabase
        .from('booking')
        .update({ status: 'cancelled', cancellationReason: reason })
        .eq('id', bookingId);

      if (booking.paymentIntentId) {
        await stripe.refunds.create({
          payment_intent: booking.paymentIntentId,
        });
      }

      return { success: true, message: 'Booking cancelled successfully' };
    } catch (error) {
      console.error('Cancel booking error:', error);
      return { success: false, error: 'Failed to cancel booking' };
    }
  },

  async getBookingStatus(bookingId: string): Promise<Booking | null> {
    const { data, error } = await supabase
      .from('booking')
      .select('*')
      .eq('id', bookingId)
      .single();

    if (error) {
      return null;
    }

    return data;
  },

  async getUserBookings(userId: string): Promise<Booking[]> {
    const { data } = await supabase
      .from('booking')
      .select('*')
      .eq('userId', userId)
      .order('createdAt', { ascending: false });

    return data || [];
  },

  async getVendorBookings(vendorId: string): Promise<Booking[]> {
    const { data: listings } = await supabase
      .from('listing')
      .select('id')
      .eq('vendorId', vendorId);

    if (!listings || listings.length === 0) {
      return [];
    }

    const listingIds = listings.map((l) => l.id);

    const { data } = await supabase
      .from('booking')
      .select('*')
      .in('listingId', listingIds)
      .order('createdAt', { ascending: false });

    return data || [];
  },
};
