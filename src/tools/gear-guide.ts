/**
 * Gear Guide (SPLIT-1741): thin clients of the backend `/gear-guide` routes.
 *
 * Renter side: the booking's topics and the question endpoint (`?stream=false`, the
 * final answer as JSON, with a fresh `Idempotency-Key` per call). Vendor side
 * (`@Roles(VENDOR)`): settings, notes (listing-scope knowledge items), gaps and the
 * model/manual state. Ownership is enforced server-side from the caller's JWT.
 * Only DTO fields are ever sent: the backend's ValidationPipe rejects undeclared ones.
 */
import { randomUUID } from 'crypto';
import { call, compact, qs, type Result } from './_shared';

/** The AI answer can take most of a minute (model chain budget 50 s), so asking gets a longer bound than the 15 s default. */
const ASK_TIMEOUT_MS = 60_000;

export const GEAR_GUIDE_GAP_STATUSES = ['open', 'answered', 'dismissed'] as const;
export type GearGuideGapStatus = (typeof GEAR_GUIDE_GAP_STATUSES)[number];

/** Lower-case words joined by single hyphens, at most 80 chars: what the backend accepts as a topic slug. */
export function topicSlugFrom(title: string, suffix: string): string {
  const base = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return base ? `${base}-${suffix}` : `note-${suffix}`;
}

/** A short title for a note: its first line, trimmed to the backend's 200-char cap. */
export function noteTitle(text: string): string {
  const firstLine = text.trim().split(/\r?\n/)[0].trim();
  return firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 77).trimEnd()}...`;
}

export const gearGuideApi = {
  /** GET /gear-guide/bookings/:id/topics : what the guide can answer for this booking. */
  topics(bookingId: string, token: string) {
    return call('GET', `/gear-guide/bookings/${bookingId}/topics`, { token });
  },

  /** POST /gear-guide/bookings/:id/ask?stream=false : the final structured answer as JSON. */
  ask(bookingId: string, token: string, input: { question: string; sessionId?: string; locale?: string }) {
    return call('POST', `/gear-guide/bookings/${bookingId}/ask${qs({ stream: 'false' })}`, {
      token,
      body: compact(input),
      headers: { 'Idempotency-Key': randomUUID() },
      timeoutMs: ASK_TIMEOUT_MS,
    });
  },

  /** The listing's settings, plus its model and that model's build state when it has one. */
  async status(listingId: string, token: string): Promise<Result<unknown>> {
    const settings = await call('GET', `/gear-guide/listings/${listingId}/settings`, { token });
    if (!settings.ok) return settings;
    const listing = await call<{ gearModelId?: string | null }>('GET', `/listings/${listingId}`, { token });
    const modelId = listing.ok && typeof listing.data?.gearModelId === 'string' ? listing.data.gearModelId : null;
    if (!modelId) return { ok: true, data: { settings: settings.data, model: null, build: null } };
    const [model, build] = await Promise.all([
      call('GET', `/gear-guide/models/${modelId}`, { token }),
      call('GET', `/gear-guide/models/${modelId}/build`, { token }),
    ]);
    return {
      ok: true,
      data: {
        settings: settings.data,
        modelId,
        model: model.ok ? model.data : { unavailable: model.error },
        build: build.ok ? build.data : { unavailable: build.error },
      },
    };
  },

  /** POST /gear-guide/listings/:id/items : a listing-scope knowledge item. */
  addNote(listingId: string, token: string, input: { kind: 'fact'; topicSlug: string; title: string; bodyMd: string; status: 'draft' | 'published' }) {
    return call('POST', `/gear-guide/listings/${listingId}/items`, { token, body: input });
  },

  /** GET /gear-guide/listings/:id/gaps?status= : questions the guide could not answer. */
  gaps(listingId: string, token: string, status?: GearGuideGapStatus) {
    return call('GET', `/gear-guide/listings/${listingId}/gaps${qs({ status })}`, { token });
  },

  /** POST /gear-guide/listings/:id/gaps/:gapId/answer : creates a FAQ item and a verified cache entry. */
  answerGap(listingId: string, gapId: string, token: string, input: { title: string; answer: string }) {
    return call('POST', `/gear-guide/listings/${listingId}/gaps/${gapId}/answer`, { token, body: input });
  },

  /** GET models/:id/build and models/:id/manuals : the manual and build state of a model. */
  async manualStatus(modelId: string, token: string): Promise<Result<unknown>> {
    const [build, manuals] = await Promise.all([
      call('GET', `/gear-guide/models/${modelId}/build`, { token }),
      call('GET', `/gear-guide/models/${modelId}/manuals`, { token }),
    ]);
    if (!build.ok) return build;
    return { ok: true, data: { build: build.data, manuals: manuals.ok ? manuals.data : { unavailable: manuals.error } } };
  },
};
