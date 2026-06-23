import { backendRequest, BackendApiError } from '@/lib/backend-client';

/**
 * Experience tools are thin clients of the backend REST API (SPLIT-226). The
 * read tools (search/details) hit the public GET /packages endpoints — the
 * canonical, moderation-filtered source — instead of a direct service-role
 * Supabase read against a schema that diverged from the real entity. The write
 * tool (bookExperience) forwards the caller's JWT (M4): the backend owns auth,
 * capacity, pricing and payment.
 *
 * SPLIT-220 (taxonomy rename): backend paths use the canonical `/packages`
 * family. The backend serves both aliases byte-identically
 * (`@Controller(['experiences', 'packages'])`), so the response shape — and
 * these tools' I/O contracts — are unchanged.
 */

type ExperienceRecord = Record<string, unknown>;

const AUTH_REQUIRED =
  'Authentication required: call with a user Bearer token (obtained from POST /api/v1/users/login).';

function toMessage(error: unknown, fallback: string): string {
  return error instanceof BackendApiError ? error.message : fallback;
}

function queryString(params: Record<string, string | undefined>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) usp.set(k, v);
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

export const experienceTools = {
  async searchExperiences(filters: { location?: string; category?: string }): Promise<ExperienceRecord[]> {
    try {
      const result = await backendRequest<{ success: boolean; experiences: ExperienceRecord[] }>(
        'GET',
        `/packages${queryString({ location: filters.location, category: filters.category, limit: '50' })}`,
      );
      return Array.isArray(result?.experiences) ? result.experiences : [];
    } catch (error) {
      console.error('Search experiences error:', toMessage(error, 'unknown'));
      return [];
    }
  },

  async getExperienceDetails(
    experienceId: string,
  ): Promise<{ experience: ExperienceRecord; schedules: ExperienceRecord[] } | null> {
    try {
      const detail = await backendRequest<{ success: boolean; experience: ExperienceRecord }>(
        'GET',
        `/packages/${experienceId}`,
      );
      if (!detail?.experience) return null;

      // Schedules are a separate public endpoint; an empty/failed schedules
      // fetch must not null out the whole detail response.
      let schedules: ExperienceRecord[] = [];
      try {
        const sched = await backendRequest<{ success: boolean; schedules: ExperienceRecord[] }>(
          'GET',
          `/packages/${experienceId}/schedules`,
        );
        schedules = Array.isArray(sched?.schedules) ? sched.schedules : [];
      } catch {
        schedules = [];
      }

      return { experience: detail.experience, schedules };
    } catch (error) {
      // 404 (or any error) → not found, matching the previous null contract.
      if (!(error instanceof BackendApiError)) console.error('Get experience details error:', error);
      return null;
    }
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
        '/packages/bookings',
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
