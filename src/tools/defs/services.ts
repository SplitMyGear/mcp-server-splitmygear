/**
 * Bookable services (guides, lessons, setup, cleaning, maintenance, delivery):
 * public discovery, customer booking + reviews, host-side booking operations
 * and the vendor's service catalogue. Backend: ServicesController (`/services`).
 * Service bookings are requests the host confirms; the API has no Stripe
 * Checkout step for them, so no tool here ever handles payment.
 */
import { z } from 'zod';
import { defineTool, fail, fromResult } from '../registry';
import {
  servicesApi,
  isAllowedServiceMediaUrl,
  SERVICE_CATEGORIES,
  SERVICE_PRICE_UNITS,
  SERVICE_STATUSES,
  SERVICE_BOOKING_STATUSES,
  SERVICE_SORT_FIELDS,
  SERVICE_HOST_ACTIONS,
  SERVICE_BOOKING_ACTION_STATUS,
  SERVICE_MEDIA_HOST_SUFFIXES,
} from '../services';
import { dateError } from '../_shared';
import { uuid, isoDate, READ, WRITE, WRITE_IDEMPOTENT, DESTRUCTIVE, UNTRUSTED_NOTE, token } from './common';

const MEDIA_HOSTS_HINT = `https URLs on ${SERVICE_MEDIA_HOST_SUFFIXES.join(', ')} (or their subdomains); the URL returned by upload_file with folder "services" qualifies.`;

const serviceMediaUrl = z
  .string()
  .max(2048)
  .refine(isAllowedServiceMediaUrl, { message: `Media URLs must be ${MEDIA_HOSTS_HINT}` });

/** The four fields `CreateServiceDto` requires. */
const requiredServiceFields = {
  title: z.string().min(1).max(200).describe('Public title, e.g. "Private kitesurfing lesson" or "Bike tune-up".'),
  description: z.string().min(1).max(5000).describe('What is included, duration, meeting point, what to bring. Shown to customers.'),
  price: z.number().min(0).max(100000).describe('Price in USD: per hour when priceUnit is hourly, flat when per_job.'),
  category: z.enum(SERVICE_CATEGORIES).describe('maintenance, cleaning, setup, training (lessons, guiding), delivery or other.'),
};

/** `CreateServiceDto` / `UpdateServiceDto` content fields, all optional here; create spreads `requiredServiceFields` over them. */
const serviceFields = {
  title: requiredServiceFields.title.optional(),
  description: requiredServiceFields.description.optional(),
  price: requiredServiceFields.price.optional(),
  category: requiredServiceFields.category.optional(),
  priceUnit: z.enum(SERVICE_PRICE_UNITS).optional().describe('hourly: customers pick 1 to 24 hours and pay price x hours; per_job (default): one flat price.'),
  location: z.string().max(200).optional().describe('City or area where the service is offered (free text, searchable).'),
  latitude: z.number().min(-90).max(90).optional().describe('Pass together with longitude.'),
  longitude: z.number().min(-180).max(180).optional().describe('Pass together with latitude.'),
  imageUrls: z.array(serviceMediaUrl).max(20).optional().describe(`Photo URLs: ${MEDIA_HOSTS_HINT}`),
  videoUrls: z.array(serviceMediaUrl).max(10).optional().describe(`Video URLs: ${MEDIA_HOSTS_HINT}`),
};

/** Lone coordinates are meaningless; the backend stores whatever it gets, so catch it here. */
function coordinatesError(latitude?: number, longitude?: number): string | null {
  if ((latitude === undefined) !== (longitude === undefined)) return 'Pass latitude and longitude together (or neither).';
  return null;
}

function readPriceUnit(service: unknown): string | undefined {
  if (!service || typeof service !== 'object') return undefined;
  const unit = (service as { priceUnit?: unknown }).priceUnit;
  return typeof unit === 'string' ? unit : undefined;
}

// ── Public discovery ─────────────────────────────────────────────────────────

export const searchServices = defineTool({
  name: 'search_services',
  title: 'Search services',
  description:
    'Browse bookable services on Splitt (guides, lessons, gear setup, cleaning, maintenance, delivery), separate from gear rentals and experiences. ' +
    'Filter by keyword (title/description), category, location and price; sort by newest, price or rating; page with page/limit. ' +
    'Returns published services with id, title, category, price + priceUnit (hourly or per_job), location, rating and the host\'s public card, plus total for paging. ' +
    'Follow up with get_service_details, then book_service. ' +
    UNTRUSTED_NOTE,
  access: 'public',
  scope: 'read',
  inputSchema: {
    search: z.string().max(200).optional().describe('Keyword matched against title and description.'),
    category: z.enum(SERVICE_CATEGORIES).optional(),
    location: z.string().max(200).optional().describe('City or area (substring match).'),
    minPrice: z.number().min(0).max(100000).optional().describe('Minimum price in USD.'),
    maxPrice: z.number().min(0).max(100000).optional().describe('Maximum price in USD.'),
    sortBy: z.enum(SERVICE_SORT_FIELDS).optional().describe('createdAt (default, newest first), price or averageRating.'),
    sortOrder: z.enum(['asc', 'desc']).optional().describe('Default desc.'),
    page: z.number().int().min(1).max(1000).optional().describe('1-based page (default 1).'),
    limit: z.number().int().min(1).max(100).optional().describe('Results per page (1 to 100, default 10).'),
  },
  annotations: READ,
  handler: async ({ sortOrder, ...query }) => {
    if (query.minPrice !== undefined && query.maxPrice !== undefined && query.minPrice > query.maxPrice) return fail('minPrice must not exceed maxPrice.');
    return fromResult(await servicesApi.searchServices({ ...query, sortOrder: sortOrder ? (sortOrder.toUpperCase() as 'ASC' | 'DESC') : undefined }), (page) => {
      const services = Array.isArray(page?.data) ? page.data : [];
      return { count: services.length, total: page?.total ?? services.length, page: page?.page ?? query.page ?? 1, limit: page?.limit ?? query.limit ?? 10, services };
    });
  },
});

export const getServiceDetails = defineTool({
  name: 'get_service_details',
  title: 'Get service details',
  description:
    'Full details of one bookable service: title, description, category, price and priceUnit (hourly services bill price x hours; per_job is a flat fee), ' +
    'location, photos/videos, rating and the host\'s public card, plus its public reviews (newest first) unless includeReviews is false. ' +
    'Only published, moderation-approved services are visible here; drafts return not found. Use before book_service to know whether to pass hours. ' +
    UNTRUSTED_NOTE,
  access: 'public',
  scope: 'read',
  inputSchema: {
    serviceId: uuid('service'),
    includeReviews: z.boolean().optional().default(true).describe('Also fetch the service\'s reviews (default true).'),
  },
  annotations: READ,
  handler: async ({ serviceId, includeReviews }) => fromResult(await servicesApi.getServiceWithReviews(serviceId, includeReviews)),
});

// ── Customer side ────────────────────────────────────────────────────────────

export const bookService = defineTool({
  name: 'book_service',
  title: 'Book a service',
  description:
    'Request a bookable service for the signed-in user at a specific date and time. Creates a PENDING request the host must confirm (or cancel); ' +
    'the customer is notified either way. Splitt prices it server-side: hourly services charge price x hours (pass hours, 1 to 24), per_job services charge the flat price. ' +
    'There is no online payment step for services in the API, so never collect payment details. Requires a date of birth (18+) and the signed platform waivers on the account; ' +
    'a host cannot book their own service. Returns the booking (id, status, scheduledAt, hours, totalPrice). Confirm date, time and hours with the user first.',
  access: 'user',
  scope: 'bookings',
  inputSchema: {
    serviceId: uuid('service'),
    scheduledAt: isoDate('When the service should take place').describe('Start date and time as an ISO 8601 timestamp with offset, e.g. 2026-07-04T09:00:00-07:00. Must be in the future.'),
    hours: z.number().int().min(1).max(24).optional().describe('Duration in hours for an hourly-priced service (1 to 24). Ignored for per_job services.'),
    customerNotes: z.string().max(2000).optional().describe('Notes for the host: skill level, meeting point preferences, gear details.'),
  },
  annotations: WRITE,
  handler: async ({ serviceId, scheduledAt, hours, customerNotes }, ctx) => {
    const err = dateError('scheduledAt', scheduledAt);
    if (err) return fail(err);
    if (new Date(scheduledAt).getTime() < Date.now() - 5 * 60_000) return fail('scheduledAt is in the past. Pick a future date and time.');
    const service = await servicesApi.getService(serviceId);
    if (!service.ok) return fromResult(service);
    const unit = readPriceUnit(service.data);
    if (unit === 'hourly' && hours === undefined) return fail('This service is priced hourly. Pass hours (1 to 24) so the total is price x hours; ask the user how long they want to book.');
    return fromResult(await servicesApi.createBooking(token(ctx), { serviceId, scheduledAt, hours: unit === 'hourly' ? hours : undefined, customerNotes }), (booking) => ({
      booking,
      nextStep: 'The request is pending until the host confirms it. Track it with get_service_booking or list_my_service_bookings; cancel_service_booking withdraws it.',
    }));
  },
});

export const listMyServiceBookings = defineTool({
  name: 'list_my_service_bookings',
  title: 'My service bookings',
  description:
    'Service bookings for the signed-in user, newest first. role "customer" (default): services the user requested; role "host": requests on services the user hosts (vendors). ' +
    'Each row has id, status (pending, confirmed, completed, cancelled, refunded), scheduledAt, hours, totalPrice, notes, the service and the other party\'s public card. ' +
    'Optionally filter by status. Rentals and experiences have their own list tools. ' +
    UNTRUSTED_NOTE,
  access: 'user',
  scope: 'bookings',
  inputSchema: {
    role: z.enum(['customer', 'host']).optional().default('customer').describe('customer: bookings I made; host: bookings on my services.'),
    status: z.enum(SERVICE_BOOKING_STATUSES).optional().describe('Keep only bookings in this status (filtered client-side).'),
  },
  annotations: READ,
  handler: async ({ role, status }, ctx) =>
    fromResult(await servicesApi.listMyBookings(token(ctx), role), (bookings) => {
      const list = Array.isArray(bookings) ? bookings : [];
      const filtered = status ? list.filter((b) => (b as { status?: string } | null)?.status === status) : list;
      return { role, count: filtered.length, bookings: filtered };
    }),
});

export const getServiceBooking = defineTool({
  name: 'get_service_booking',
  title: 'Get service booking',
  description:
    'One service booking the signed-in user is a party to (customer or host): status, scheduledAt, hours, totalPrice, customer and vendor notes, the service and the other party\'s public card. ' +
    'Pass includeHistory to also get the status timeline (who changed what, when). ' +
    UNTRUSTED_NOTE,
  access: 'user',
  scope: 'bookings',
  inputSchema: {
    bookingId: uuid('service booking'),
    includeHistory: z.boolean().optional().default(false).describe('Also return the status-change timeline (default false).'),
  },
  annotations: READ,
  handler: async ({ bookingId, includeHistory }, ctx) => fromResult(await servicesApi.getBookingWithHistory(token(ctx), bookingId, includeHistory)),
});

export const cancelServiceBooking = defineTool({
  name: 'cancel_service_booking',
  title: 'Cancel service booking',
  description:
    'Cancel a pending or confirmed service booking: the customer withdraws their request, or the host declines/cancels a booking on their service. ' +
    'Completed or already-cancelled bookings cannot be cancelled. The other party is notified. This cannot be undone; confirm with the user first.',
  access: 'user',
  scope: 'bookings',
  inputSchema: { bookingId: uuid('service booking') },
  annotations: DESTRUCTIVE,
  handler: async ({ bookingId }, ctx) => fromResult(await servicesApi.updateBookingStatus(token(ctx), bookingId, { status: SERVICE_BOOKING_ACTION_STATUS.cancel })),
});

export const reviewService = defineTool({
  name: 'review_service',
  title: 'Review a service',
  description:
    'Leave a rating (1 to 5) and optional comment on a service the signed-in user booked and COMPLETED. One review per service per user; it cannot be edited or deleted afterwards, ' +
    'so read the text back to the user before posting. Comments pass Splitt\'s moderation (a rejected comment returns a 400 with the reason). Returns the saved review.',
  access: 'user',
  scope: 'reviews',
  inputSchema: {
    serviceId: uuid('service'),
    rating: z.number().int().min(1).max(5).describe('1 (poor) to 5 (excellent).'),
    comment: z.string().max(2000).optional().describe('Public review text (max 2000 characters).'),
  },
  annotations: WRITE,
  handler: async ({ serviceId, rating, comment }, ctx) => {
    const text = comment?.trim();
    return fromResult(await servicesApi.createReview(token(ctx), { serviceId, rating, comment: text ? text : undefined }));
  },
});

// ── Host side: booking operations ────────────────────────────────────────────

export const updateServiceBookingStatus = defineTool({
  name: 'update_service_booking_status',
  title: 'Confirm / complete service booking',
  description:
    'Host actions on a booking of one of the signed-in vendor\'s services: action "confirm" accepts a pending request, action "complete" marks a pending or confirmed booking as delivered ' +
    '(the customer can then review it). Optionally set or replace vendorNotes (private to the host) with or without a status change. ' +
    'Use cancel_service_booking to decline or cancel. Returns the updated booking.',
  access: 'vendor',
  scope: 'vendor_bookings',
  inputSchema: {
    bookingId: uuid('service booking'),
    action: z.enum(SERVICE_HOST_ACTIONS).optional().describe('confirm: pending to confirmed; complete: pending/confirmed to completed. Omit to only update vendorNotes.'),
    vendorNotes: z.string().max(2000).optional().describe('Host-only notes on the booking (replaces the previous text).'),
  },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ bookingId, action, vendorNotes }, ctx) => {
    if (action === undefined && vendorNotes === undefined) return fail('Pass an action (confirm or complete) and/or vendorNotes.');
    return fromResult(await servicesApi.updateBookingStatus(token(ctx), bookingId, { status: action ? SERVICE_BOOKING_ACTION_STATUS[action] : undefined, vendorNotes }));
  },
});

// ── Host side: catalogue ─────────────────────────────────────────────────────

export const listMyServices = defineTool({
  name: 'list_my_services',
  title: 'My services',
  description:
    'The signed-in vendor\'s published services (id, title, category, price, priceUnit, status, rating, moderation state). ' +
    'Limitation: Splitt\'s API has no owner-side service listing yet, so this scans the public catalogue and keeps the vendor\'s rows; drafts, archived and not-yet-approved services ' +
    'do not appear. Keep the id returned by create_service to manage a draft. Service ids from here feed update_service and delete_service.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: {},
  annotations: READ,
  handler: async (_args, ctx) => {
    if (!ctx.userId) return fail('Could not determine the signed-in user; reconnect and try again.');
    return fromResult(await servicesApi.listMyServices(ctx.userId), (d) => ({ count: d.services.length, services: d.services, truncated: d.truncated }));
  },
});

export const createService = defineTool({
  name: 'create_service',
  title: 'Create a service',
  description:
    'Create a bookable service (lesson, guided outing, gear setup, cleaning, maintenance, delivery) for the signed-in vendor. It starts as a draft and is queued for moderation; ' +
    'publish it with update_service(status="published") once ready. It becomes searchable and bookable only when published and approved. ' +
    'Required: title, description, price, category. Returns the created service with its id (keep it: drafts are not listed by list_my_services).',
  access: 'vendor',
  scope: 'listings',
  inputSchema: { ...serviceFields, ...requiredServiceFields },
  annotations: WRITE,
  handler: async (args, ctx) => {
    const err = coordinatesError(args.latitude, args.longitude);
    if (err) return fail(err);
    return fromResult(await servicesApi.createService(token(ctx), { ...args, title: args.title.trim(), description: args.description.trim() }));
  },
});

export const updateService = defineTool({
  name: 'update_service',
  title: 'Update a service',
  description:
    'Edit one of the signed-in vendor\'s services: content, price/priceUnit, category, location, media, or status ("published" to go live, "archived" to take it offline, "draft" to hide it). ' +
    'Only the fields you pass change. Every edit re-runs moderation in the background, so a just-published service may take a moment to appear in search. Returns the updated service.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: {
    serviceId: uuid('service'),
    ...serviceFields,
    status: z.enum(SERVICE_STATUSES).optional().describe('published: bookable; archived: offline but kept; draft: hidden while editing.'),
  },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ serviceId, ...rest }, ctx) => {
    if (Object.values(rest).every((v) => v === undefined)) return fail('Pass at least one field to update (title, description, price, status, ...).');
    const err = coordinatesError(rest.latitude, rest.longitude);
    if (err) return fail(err);
    return fromResult(await servicesApi.updateService(token(ctx), serviceId, rest));
  },
});

export const deleteService = defineTool({
  name: 'delete_service',
  title: 'Delete a service',
  description:
    'Permanently delete one of the signed-in vendor\'s services. This also removes its bookings and reviews and cannot be undone; prefer update_service(status="archived") to take it offline. ' +
    'Only for services created by mistake or never booked. Confirm with the user first.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: { serviceId: uuid('service') },
  annotations: DESTRUCTIVE,
  handler: async ({ serviceId }, ctx) => fromResult(await servicesApi.deleteService(token(ctx), serviceId), () => ({ deleted: true, serviceId })),
});

export const serviceTools = [
  searchServices,
  getServiceDetails,
  bookService,
  listMyServiceBookings,
  getServiceBooking,
  cancelServiceBooking,
  reviewService,
  updateServiceBookingStatus,
  listMyServices,
  createService,
  updateService,
  deleteService,
];
