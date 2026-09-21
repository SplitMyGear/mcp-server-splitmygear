/**
 * External calendar sync for a vendor's listings (SPLIT-1177/1178/1390/1391/1392).
 *
 * Two directions:
 *  - INBOUND: iCal feeds a vendor connects to a listing (Airbnb, VRBO, Google
 *    Calendar, ...). Their busy dates become SYNC holds that block the listing;
 *    Splitt re-imports every enabled feed nightly and a vendor can trigger a
 *    sync by hand. Deleting a synced hold creates a "suppression" (the hold
 *    stays gone on later syncs) which the vendor can undo.
 *  - OUTBOUND: the listing's public iCal export and the account-level
 *    subscription link that puts every Splitt booking into the vendor's own
 *    calendar app. The subscription URL carries a bearer token in its path.
 *
 * Thin clients of the backend `/rentals/:id/calendar-feeds`, `/calendar-feeds`
 * and `/vendor/calendar/subscription` routes; the backend's
 * VendorOrPrivilegedGuard / @Roles(VENDOR) plus its ownership assertions decide
 * who may touch which feed. Only DTO-declared fields are ever sent (the
 * backend's global ValidationPipe rejects undeclared fields with a 400), so
 * every body goes through `compact`.
 */
import { backendBaseUrl } from '@/lib/backend-client';
import { call, compact } from './_shared';

export type CalendarFeedSyncStatus = 'success' | 'failed';

/** A synced hold the vendor removed by hand; the hold stays gone until the suppression expires or is cleared. */
export interface CalendarFeedSuppression {
  id: string;
  uid: string;
  recurrenceId: string;
  summary: string | null;
  expiresAt: string;
  createdAt: string;
}

/** Wire shape of a connected feed (`CalendarFeedView` on the backend). */
export interface CalendarFeed {
  id: string;
  listingId: string;
  url: string;
  label: string | null;
  isEnabled: boolean;
  lastSyncedAt: string | null;
  lastSyncStatus: CalendarFeedSyncStatus | null;
  lastSyncError: string | null;
  consecutiveFailures: number;
  createdAt: string;
  /** True when Splitt switched the feed off after repeated failures (as opposed to the vendor turning it off). */
  autoDisabled: boolean;
  failingSince: string | null;
  nextAttemptAt: string | null;
  /** Units one hold consumes; null means a hold closes the whole listing. */
  unitsPerHold: number | null;
  suppressions?: CalendarFeedSuppression[];
}

export interface CalendarFeedSyncResult {
  feed: CalendarFeed;
  importedCount: number;
  removedCount: number;
}

/** `GET /vendor/calendar/subscription`: the token is also embedded in `url`, so tools never need to surface it separately. */
export interface CalendarSubscription {
  token: string;
  url: string;
  webcalUrl: string;
  issuedAt: string;
}

/** `CreateCalendarFeedDto`. */
export interface CreateCalendarFeedInput {
  url: string;
  label?: string;
  unitsPerHold?: number;
}

/** `UpdateCalendarFeedDto`: `unitsPerHold: null` clears the setting (a hold closes the listing again). */
export interface UpdateCalendarFeedInput {
  label?: string;
  isEnabled?: boolean;
  unitsPerHold?: number | null;
}

/**
 * Trim a calendar URL and map the `webcal://` scheme calendar apps hand out to
 * `https://` (the backend DTO accepts http/https only). Returns the string
 * unchanged otherwise; protocol validation happens in the tool handler.
 */
export function normalizeCalendarUrl(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.replace(/^webcal:\/\//i, 'https://');
}

/** Is this an absolute http(s) URL the backend's `IsUrl({ protocols: ['http','https'] })` will accept? */
export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.length > 0;
  } catch {
    return false;
  }
}

/** The public, unauthenticated iCal export of one listing's bookings and blocked dates. */
export function listingIcalExportUrl(listingId: string): string {
  return `${backendBaseUrl().replace(/\/+$/, '')}/bookings/ical/${listingId}`;
}

export const calendarFeedApi = {
  /** Every feed connected to a listing, oldest first, each with its active suppressions. */
  list(token: string, listingId: string) {
    return call<CalendarFeed[]>('GET', `/rentals/${listingId}/calendar-feeds`, { token });
  },

  /**
   * Connect (or re-sync, when the same URL is already connected) a feed and
   * import it immediately. The backend fetches the URL inline (SSRF-guarded,
   * 8s upstream timeout), caps feeds at 5 per listing / 25 per vendor and rate
   * limits connect+sync to 10 per 10 minutes.
   */
  add(token: string, listingId: string, input: CreateCalendarFeedInput) {
    return call<CalendarFeedSyncResult>('POST', `/rentals/${listingId}/calendar-feeds`, { token, body: compact(input) });
  },

  /** Fetch + reconcile one feed now. Shares the connect rate limit (10 per 10 minutes). */
  sync(token: string, feedId: string) {
    return call<CalendarFeedSyncResult>('POST', `/calendar-feeds/${feedId}/sync`, { token, body: {} });
  },

  /** Change label / enabled / unitsPerHold without re-fetching the URL. Re-enabling clears the auto-disable state. */
  update(token: string, feedId: string, input: UpdateCalendarFeedInput) {
    return call<CalendarFeed>('PATCH', `/calendar-feeds/${feedId}`, { token, body: compact(input) });
  },

  /** Disconnect a feed (204). Its suppressions go with it (FK cascade). */
  remove(token: string, feedId: string) {
    return call<void>('DELETE', `/calendar-feeds/${feedId}`, { token });
  },

  /** Undo a suppression (204) so the next sync brings the hold back. */
  removeSuppression(token: string, suppressionId: string) {
    return call<void>('DELETE', `/calendar-feeds/suppressions/${suppressionId}`, { token });
  },

  /** Get-or-create the vendor's account-level subscription link (mints a token on first use). */
  getSubscription(token: string) {
    return call<CalendarSubscription>('GET', '/vendor/calendar/subscription', { token });
  },

  /** Mint a new subscription token; the previous link 404s immediately. */
  rotateSubscription(token: string) {
    return call<CalendarSubscription>('POST', '/vendor/calendar/subscription/rotate', { token, body: {} });
  },
};
