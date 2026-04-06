import { supabase, Experience, ExperienceSchedule } from '@/lib/supabase';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2023-10-16',
});

export const experienceTools = {
  async searchExperiences(filters: { location?: string; category?: string }): Promise<Experience[]> {
    let query = supabase
      .from('experience')
      .select('*')
      .eq('status', 'published');

    if (filters.location) {
      query = query.ilike('location', `%${filters.location}%`);
    }

    if (filters.category) {
      query = query.eq('category', filters.category);
    }

    const { data, error } = await query.limit(50);

    if (error) {
      console.error('Search experiences error:', error);
      return [];
    }

    return data || [];
  },

  async getExperienceDetails(experienceId: string): Promise<{ experience: Experience; schedules: ExperienceSchedule[] } | null> {
    const { data: experience, error: expError } = await supabase
      .from('experience')
      .select('*')
      .eq('id', experienceId)
      .single();

    if (expError || !experience) {
      return null;
    }

    const { data: schedules } = await supabase
      .from('experience_schedule')
      .select('*')
      .eq('experienceId', experienceId)
      .eq('status', 'available')
      .gte('date', new Date().toISOString().split('T')[0]);

    return {
      experience,
      schedules: schedules || [],
    };
  },

  async bookExperience(
    scheduleId: string,
    userId: string,
    guests: number
  ): Promise<{ success: boolean; bookingId?: string; clientSecret?: string; error?: string }> {
    try {
      const { data: schedule, error: schError } = await supabase
        .from('experience_schedule')
        .select('*, experience:experienceId(pricePerPerson, hostId)')
        .eq('id', scheduleId)
        .single();

      if (schError || !schedule) {
        return { success: false, error: 'Schedule not found' };
      }

      const availableSpots = schedule.spotsTotal - schedule.spotsBooked;
      if (availableSpots < guests) {
        return { success: false, error: 'Not enough spots available' };
      }

      const totalPrice = schedule.experience.pricePerPerson * guests;

      const { data: booking, error: bookError } = await supabase
        .from('experience_booking')
        .insert({
          experienceId: schedule.experienceId,
          scheduleId,
          userId,
          guests,
          totalPrice,
          status: 'pending',
        })
        .select()
        .single();

      if (bookError) {
        return { success: false, error: bookError.message };
      }

      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(totalPrice * 100),
        currency: 'usd',
        metadata: {
          experienceBookingId: booking.id,
          userId,
        },
      });

      await supabase
        .from('experience_booking')
        .update({ paymentIntentId: paymentIntent.id })
        .eq('id', booking.id);

      return {
        success: true,
        bookingId: booking.id,
        clientSecret: paymentIntent.client_secret || undefined,
      };
    } catch (error) {
      console.error('Book experience error:', error);
      return { success: false, error: 'Failed to book experience' };
    }
  },
};
