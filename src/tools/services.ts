/**
 * Bookable services (guides, lessons, setup, cleaning, maintenance, delivery):
 * the third booking flow next to rentals and experiences. Thin clients of the
 * backend `/services` routes (ServicesController). The backend owns visibility
 * (public browse/detail are PUBLISHED + moderation-APPROVED only), pricing
 * (HOURLY services bill price x hours, PER_JOB the flat price), the booking
 * lifecycle matrix (host confirms/completes/cancels, customer cancels), review
 * eligibility and ownership. Only DTO-declared fields are ever sent (the global
 * ValidationPipe rejects undeclared fields with a 400), so every body goes
 * through `compact`.
 *
 * Service bookings have no Stripe Checkout step in the API: `POST
 * /services/bookings` creates a PENDING request that the host confirms.
 */
import { call, compact, qs, type Result } from './_shared';

/** `ServiceCategory` (service.entity.ts). */
export const SERVICE_CATEGORIES = ['maintenance', 'cleaning', 'setup', 'training', 'delivery', 'other'] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

/** `PriceUnit`: hourly bills price x hours (1 to 24); per_job bills the flat price once. */
export const SERVICE_PRICE_UNITS = ['hourly', 'per_job'] as const;
export type ServicePriceUnit = (typeof SERVICE_PRICE_UNITS)[number];

/** `ServiceStatus`: a host publishes via PUT /services/:id (create always starts as draft). */
export const SERVICE_STATUSES = ['draft', 'published', 'archived'] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

/** `ServiceBookingStatus`; `refunded` is never user-settable. */
export const SERVICE_BOOKING_STATUSES = ['pending', 'confirmed', 'cancelled', 'completed', 'refunded'] as const;
export type ServiceBookingStatus = (typeof SERVICE_BOOKING_STATUSES)[number];

/** `QueryServicesDto.sortBy`. */
export const SERVICE_SORT_FIELDS = ['createdAt', 'price', 'averageRating'] as const;
export type ServiceSortField = (typeof SERVICE_SORT_FIELDS)[number];

/** Host-side booking transitions (booking-lifecycle.ts, SERVICE flow, OWNER actor). */
export const SERVICE_HOST_ACTIONS = ['confirm', 'complete'] as const;
export type ServiceHostAction = (typeof SERVICE_HOST_ACTIONS)[number];

/** Action -> target status for PUT /services/bookings/:id/status. */
export const SERVICE_BOOKING_ACTION_STATUS: Record<ServiceHostAction | 'cancel', ServiceBookingStatus> = {
  confirm: 'confirmed',
  complete: 'completed',
  cancel: 'cancelled',
};

/**
 * Host suffixes the backend accepts for vendor media URLs (`MEDIA_HOST_WHITELIST`
 * in common/upload-url.validation.ts): https only, host equal to or a subdomain of
 * one of these. Mirrored so the model gets a clear message before a round-trip.
 */
export const SERVICE_MEDIA_HOST_SUFFIXES = [
  'splitmygear.com',
  'googleapis.com',
  'amazonaws.com',
  'cloudinary.com',
  'supabase.co',
  'supabase.in',
  'unsplash.com',
  'public.blob.vercel-storage.com',
] as const;

/** True when `value` is an https URL on an allow-listed media host. */
export function isAllowedServiceMediaUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return SERVICE_MEDIA_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** `QueryServicesDto` (the backend ignores a client `status`; public browse is published-only). A type alias so it satisfies `qs()`'s record parameter. */
export type ServiceQuery = {
  search?: string;
  category?: ServiceCategory;
  location?: string;
  minPrice?: number;
  maxPrice?: number;
  sortBy?: ServiceSortField;
  sortOrder?: 'ASC' | 'DESC';
  page?: number;
  limit?: number;
};

/** `CreateServiceDto` (status is deliberately not accepted on create). */
export interface ServiceInput {
  title: string;
  description: string;
  price: number;
  priceUnit?: ServicePriceUnit;
  category: ServiceCategory;
  location?: string;
  latitude?: number;
  longitude?: number;
  imageUrls?: string[];
  videoUrls?: string[];
}

/** `UpdateServiceDto`: every create field optional, plus `status`. */
export interface ServiceUpdate extends Partial<ServiceInput> {
  status?: ServiceStatus;
}

/** `CreateServiceBookingDto`. */
export interface ServiceBookingInput {
  serviceId: string;
  scheduledAt: string;
  hours?: number;
  customerNotes?: string;
}

/** `UpdateServiceBookingDto`: a status transition and/or host-only vendorNotes. */
export interface ServiceBookingUpdate {
  status?: ServiceBookingStatus;
  vendorNotes?: string;
}

/** `CreateServiceReviewDto`. */
export interface ServiceReviewInput {
  serviceId: string;
  rating: number;
  comment?: string;
}

/** Browse page envelope returned by GET /services. */
export interface ServicePage {
  data?: unknown[];
  total?: number;
  page?: number;
  limit?: number;
}

/** Pages of 100 scanned by `listMyServices` before giving up (services are a small catalogue). */
const MY_SERVICES_MAX_PAGES = 5;

function isHostedBy(row: unknown, userId: string): boolean {
  if (!row || typeof row !== 'object') return false;
  const r = row as { hostId?: unknown; host?: { id?: unknown } | null };
  return r.hostId === userId || r.host?.id === userId;
}

export const servicesApi = {
  // ── Public discovery ────────────────────────────────────────────────────

  /** Published, moderation-approved services with `{ data, total, page, limit }`. */
  searchServices(query: ServiceQuery) {
    return call<ServicePage>('GET', `/services${qs(query)}`);
  },

  /** One published service with its public host card; 404 for drafts and unapproved services. */
  getService(serviceId: string) {
    return call('GET', `/services/${serviceId}`);
  },

  /** Public reviews of a service, newest first, with public reviewer cards. */
  getServiceReviews(serviceId: string) {
    return call<unknown[]>('GET', `/services/${serviceId}/reviews`);
  },

  /** Detail plus (optionally) reviews in one call; a failed reviews fetch never hides the service. */
  async getServiceWithReviews(serviceId: string, includeReviews: boolean): Promise<Result<{ service: unknown; reviews?: unknown[] | null; reviewsError?: string }>> {
    const [service, reviews] = await Promise.all([this.getService(serviceId), includeReviews ? this.getServiceReviews(serviceId) : Promise.resolve(null)]);
    if (!service.ok) return service;
    if (!reviews) return { ok: true, data: { service: service.data } };
    return {
      ok: true,
      data: reviews.ok ? { service: service.data, reviews: reviews.data } : { service: service.data, reviews: null, reviewsError: reviews.error },
    };
  },

  // ── Bookings (customer + host) ──────────────────────────────────────────

  /** Creates a PENDING request; identical retries within 5 minutes return the existing booking. */
  createBooking(token: string, input: ServiceBookingInput) {
    return call('POST', '/services/bookings', { token, body: compact(input) });
  },

  /** `customer`: bookings the user made; `host`: bookings on services the user hosts. */
  listMyBookings(token: string, role: 'customer' | 'host') {
    return call<unknown[]>('GET', `/services/bookings/my-bookings${qs({ role })}`, { token });
  },

  getBooking(token: string, bookingId: string) {
    return call('GET', `/services/bookings/${bookingId}`, { token });
  },

  /** Status timeline (party or admin only). */
  getBookingHistory(token: string, bookingId: string) {
    return call<unknown[]>('GET', `/services/bookings/${bookingId}/history`, { token });
  },

  /** Booking plus, optionally, its status timeline; a failed history fetch never hides the booking. */
  async getBookingWithHistory(token: string, bookingId: string, includeHistory: boolean): Promise<Result<{ booking: unknown; history?: unknown[] | null; historyError?: string }>> {
    const [booking, history] = await Promise.all([this.getBooking(token, bookingId), includeHistory ? this.getBookingHistory(token, bookingId) : Promise.resolve(null)]);
    if (!booking.ok) return booking;
    if (!history) return { ok: true, data: { booking: booking.data } };
    return {
      ok: true,
      data: history.ok ? { booking: booking.data, history: history.data } : { booking: booking.data, history: null, historyError: history.error },
    };
  },

  /** The backend's lifecycle matrix decides who may (host: confirm/complete/cancel; customer: cancel). */
  updateBookingStatus(token: string, bookingId: string, input: ServiceBookingUpdate) {
    return call('PUT', `/services/bookings/${bookingId}/status`, { token, body: compact(input) });
  },

  // ── Reviews ─────────────────────────────────────────────────────────────

  /** Requires a COMPLETED booking by the reviewer; one review per service per user; comment is AI-moderated. */
  createReview(token: string, input: ServiceReviewInput) {
    return call('POST', '/services/reviews', { token, body: compact(input) });
  },

  // ── Host (vendor) management ────────────────────────────────────────────

  /** Always created as `draft` with moderation pending; publish via `updateService({ status: 'published' })`. */
  createService(token: string, input: ServiceInput) {
    return call('POST', '/services', { token, body: compact(input) });
  },

  /** Host only (403 otherwise); every edit re-runs moderation in the background. */
  updateService(token: string, serviceId: string, input: ServiceUpdate) {
    return call('PUT', `/services/${serviceId}`, { token, body: compact(input) });
  },

  /** Host only; hard delete that cascades to the service's bookings and reviews (204). */
  deleteService(token: string, serviceId: string) {
    return call<void>('DELETE', `/services/${serviceId}`, { token });
  },

  /**
   * The backend has no owner-side listing for services, so this scans the public
   * browse (published + approved only) and keeps the rows hosted by `userId` (the
   * id from the caller's own verified token, never a tool argument). Drafts and
   * archived services cannot be listed until the backend adds `/services/my-services`.
   */
  async listMyServices(userId: string): Promise<Result<{ services: unknown[]; scanned: number; total: number; truncated: boolean }>> {
    const services: unknown[] = [];
    let scanned = 0;
    let total = 0;
    for (let page = 1; page <= MY_SERVICES_MAX_PAGES; page += 1) {
      const res = await this.searchServices({ limit: 100, page });
      if (!res.ok) return res;
      const rows = Array.isArray(res.data?.data) ? res.data.data : [];
      total = typeof res.data?.total === 'number' ? res.data.total : scanned + rows.length;
      scanned += rows.length;
      for (const row of rows) if (isHostedBy(row, userId)) services.push(row);
      if (rows.length === 0 || scanned >= total) break;
    }
    return { ok: true, data: { services, scanned, total, truncated: scanned < total } };
  },
};
