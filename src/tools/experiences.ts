import { backendRequest, BackendApiError } from '@/lib/backend-client';
import { call, compact } from './_shared';

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

// SPLIT-197 §C-MCP contract gap: unlike listings (`Listing`) and chat
// (`Conversation`/`Message`), experiences/packages have NO entity schema in the
// backend OpenAPI contract at all (only Create/Update DTOs), and the
// `GET/POST /packages*` routes declare bare `object` responses. So there is
// nothing generated to derive these element/response types from; they stay
// untyped `Record<string, unknown>` records with narrow local response
// envelopes. A backend `Experience` entity schema + typed `@ApiResponse` would
// let these be generated like the listing tools.
type ExperienceRecord = Record<string, unknown>;

/** Fields of the backend's CreateExperienceDto the MCP exposes. */
export interface ExperienceInput {
  title: string;
  description: string;
  shortDescription?: string;
  category?: string;
  duration: number;
  durationUnit: string;
  minGuests?: number;
  maxGuests?: number;
  pricePerPerson: number;
  pricePerChild?: number;
  location?: string;
  latitude?: number;
  longitude?: number;
  meetingPoint?: string;
  whatsIncluded?: string[];
  whatToBring?: string[];
  requirements?: string;
  cancellationPolicy?: string;
  imageUrls?: string[];
}

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
    children?: number;
    guestNotes?: string;
    isPrivateGroup?: boolean;
    withPaymentLink?: boolean;
    token: string;
  }): Promise<{ success: boolean; booking?: Record<string, unknown>; bookingId?: string; paymentUrl?: string; paymentError?: string; error?: string }> {
    if (!params.token) return { success: false, error: AUTH_REQUIRED };
    try {
      const result = await backendRequest<{ success: boolean; booking: { id: string; [k: string]: unknown } }>(
        'POST',
        '/packages/bookings',
        {
          token: params.token,
          body: compact({
            experienceId: params.experienceId,
            scheduleId: params.scheduleId,
            numberOfGuests: params.guests,
            numberOfChildren: params.children,
            guestNotes: params.guestNotes,
            isPrivateGroup: params.isPrivateGroup,
          }),
        },
      );
      // Tolerate both `{ booking }` envelopes and a bare booking object.
      const booking = (result?.booking ?? (result as unknown)) as { id?: string; [k: string]: unknown } | undefined;
      const bookingId = booking?.id;
      if (!params.withPaymentLink || !bookingId) return { success: true, booking, bookingId };
      const checkout = await this.createCheckoutSession(bookingId, params.token);
      return checkout.ok
        ? { success: true, booking, bookingId, paymentUrl: checkout.data?.checkoutUrl }
        : { success: true, booking, bookingId, paymentError: checkout.error };
    } catch (error) {
      return { success: false, error: toMessage(error, 'Failed to book experience') };
    }
  },

  /** Stripe Checkout for an experience booking (backend picks return URLs). */
  createCheckoutSession(bookingId: string, token: string) {
    return call<{ checkoutUrl?: string; sessionId?: string }>('POST', `/packages/bookings/${bookingId}/checkout-session`, { token, body: {} });
  },

  listMyExperienceBookings(token: string) {
    return call('GET', '/packages/bookings/my', { token });
  },

  getExperienceBooking(bookingId: string, token: string) {
    return call('GET', `/packages/bookings/${bookingId}`, { token });
  },

  /** Guest cancel, or host confirm/cancel/complete — the backend's lifecycle matrix decides who may. */
  transitionExperienceBooking(bookingId: string, action: 'confirm' | 'cancel' | 'complete', token: string) {
    return call('POST', `/packages/bookings/${bookingId}/${action}`, { token, body: {} });
  },

  // ── Host (vendor) management ─────────────────────────────────────────────

  listMyExperiences(token: string) {
    return call('GET', '/packages/my-experiences', { token });
  },

  createExperience(token: string, input: ExperienceInput) {
    return call('POST', '/packages', { token, body: compact(input) });
  },

  updateExperience(experienceId: string, token: string, input: Partial<ExperienceInput>) {
    return call('PUT', `/packages/${experienceId}`, { token, body: compact(input) });
  },

  setExperienceStatus(experienceId: string, action: 'publish' | 'archive', token: string) {
    return call('POST', `/packages/${experienceId}/${action}`, { token, body: {} });
  },

  addSchedule(experienceId: string, token: string, input: { date: string; startTime: string; endTime?: string; spotsTotal?: number; customPrice?: number; notes?: string }) {
    return call('POST', `/packages/${experienceId}/schedules`, { token, body: compact(input) });
  },

  deleteSchedule(experienceId: string, scheduleId: string, token: string) {
    return call('DELETE', `/packages/${experienceId}/schedules/${scheduleId}`, { token });
  },

  listHostBookings(token: string) {
    return call('GET', '/packages/host/bookings', { token });
  },
};
