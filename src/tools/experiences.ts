import { supabase, Experience, ExperienceSchedule } from '@/lib/supabase';
import { backendRequest, BackendApiError } from '@/lib/backend-client';

/**
 * `bookExperience` calls the backend REST API forwarding the caller's JWT
 * (SPLIT-226 / M4) — the backend owns auth, capacity/availability, pricing and
 * payment. The read tools (search/details) remain direct Supabase reads for now
 * (migrating those to GET /experiences is tracked as a follow-up).
 */

const AUTH_REQUIRED =
  'Authentication required: call with a user Bearer token (obtained from POST /api/v1/users/login).';

function toMessage(error: unknown, fallback: string): string {
  return error instanceof BackendApiError ? error.message : fallback;
}

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

  async bookExperience(params: {
    experienceId: string;
    scheduleId?: string;
    guests: number;
    token: string;
  }): Promise<{ success: boolean; booking?: Record<string, unknown>; bookingId?: string; error?: string }> {
    if (!params.token) return { success: false, error: AUTH_REQUIRED };
    try {
      const result = await backendRequest<{ success: boolean; booking: { id: string; [k: string]: unknown } }>(
        'POST',
        '/experiences/bookings',
        {
          token: params.token,
          body: {
            experienceId: params.experienceId,
            ...(params.scheduleId ? { scheduleId: params.scheduleId } : {}),
            numberOfGuests: params.guests,
          },
        },
      );
      return { success: true, booking: result.booking, bookingId: result.booking?.id };
    } catch (error) {
      return { success: false, error: toMessage(error, 'Failed to book experience') };
    }
  },
};
