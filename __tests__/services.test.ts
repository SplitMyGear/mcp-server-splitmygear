/** Contract tests for the services backend module + tool defs: exact method/path/body/token per call, handler guards, schemas. */
export {};

const mockBackendRequest = jest.fn();
jest.mock('../src/lib/backend-client', () => {
  class BackendApiError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.name = 'BackendApiError'; this.status = status; }
  }
  return { BackendApiError, backendRequest: (...args: unknown[]) => mockBackendRequest(...args) };
});

import {
  servicesApi,
  isAllowedServiceMediaUrl,
  SERVICE_CATEGORIES,
  SERVICE_PRICE_UNITS,
  SERVICE_STATUSES,
  SERVICE_BOOKING_STATUSES,
  SERVICE_HOST_ACTIONS,
  SERVICE_BOOKING_ACTION_STATUS,
} from '../src/tools/services';
import {
  serviceTools,
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
} from '../src/tools/defs/services';
import { TOOL_SCOPES, type ToolContext } from '../src/tools/registry';
import { z } from 'zod';

const T = 'h.p.s';
const S = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ME = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const userCtx: ToolContext = { userId: ME, role: 'renter', token: T, kind: 'oauth' };
const vendorCtx: ToolContext = { userId: ME, role: 'vendor', token: T, kind: 'oauth' };
const publicCtx: ToolContext = { kind: 'operator' } as ToolContext;
const { BackendApiError } = jest.requireMock('../src/lib/backend-client');
const FUTURE = new Date(Date.now() + 7 * 86_400_000).toISOString();
const BLOB = 'https://abc.public.blob.vercel-storage.com/services/photo.jpg';

function lastCall() {
  const c = mockBackendRequest.mock.calls[mockBackendRequest.mock.calls.length - 1];
  return { method: c[0], path: c[1], opts: c[2] ?? {} };
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[0]?.text ?? '';
}

beforeEach(() => {
  mockBackendRequest.mockReset();
  mockBackendRequest.mockResolvedValue({ ok: 1 });
});

describe('servicesApi (backend module)', () => {
  it('browses and reads services publicly (no token) with only DTO query fields', async () => {
    await servicesApi.searchServices({ search: 'kite lesson', category: 'training', location: 'Hood River', minPrice: 20, maxPrice: 200, sortBy: 'price', sortOrder: 'ASC', page: 2, limit: 25 });
    expect(lastCall()).toMatchObject({
      method: 'GET',
      path: '/services?search=kite+lesson&category=training&location=Hood+River&minPrice=20&maxPrice=200&sortBy=price&sortOrder=ASC&page=2&limit=25',
    });
    expect(lastCall().opts.token).toBeUndefined();
    expect(lastCall().opts.body).toBeUndefined();
    await servicesApi.searchServices({ category: undefined, limit: 10 });
    expect(lastCall().path).toBe('/services?limit=10');
    await servicesApi.getService(S);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/services/${S}` });
    expect(lastCall().opts.token).toBeUndefined();
    await servicesApi.getServiceReviews(S);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/services/${S}/reviews` });
  });

  it('getServiceWithReviews merges detail + reviews and tolerates a failed reviews fetch', async () => {
    mockBackendRequest.mockImplementation(async (_m: string, path: string) => (path.endsWith('/reviews') ? [{ id: 'r1' }] : { id: S, title: 'Lesson' }));
    expect(await servicesApi.getServiceWithReviews(S, true)).toEqual({ ok: true, data: { service: { id: S, title: 'Lesson' }, reviews: [{ id: 'r1' }] } });
    expect(await servicesApi.getServiceWithReviews(S, false)).toEqual({ ok: true, data: { service: { id: S, title: 'Lesson' } } });
    expect(mockBackendRequest.mock.calls.filter((c) => c[1].endsWith('/reviews'))).toHaveLength(1);
    mockBackendRequest.mockImplementation(async (_m: string, path: string) => {
      if (path.endsWith('/reviews')) throw new BackendApiError(500, 'down');
      return { id: S };
    });
    expect(await servicesApi.getServiceWithReviews(S, true)).toEqual({ ok: true, data: { service: { id: S }, reviews: null, reviewsError: 'down' } });
    mockBackendRequest.mockImplementation(async (_m: string, path: string) => {
      if (path.endsWith('/reviews')) return [];
      throw new BackendApiError(404, `Service with ID ${S} not found`);
    });
    expect(await servicesApi.getServiceWithReviews(S, true)).toEqual({ ok: false, error: `Service with ID ${S} not found`, status: 404 });
  });

  it('creates, lists, reads and transitions bookings with the token and compacted DTO bodies', async () => {
    await servicesApi.createBooking(T, { serviceId: S, scheduledAt: '2026-07-04T09:00:00-07:00', hours: 2, customerNotes: undefined });
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/services/bookings', opts: { token: T, body: { serviceId: S, scheduledAt: '2026-07-04T09:00:00-07:00', hours: 2 } } });
    expect(lastCall().opts.body).not.toHaveProperty('customerNotes');
    await servicesApi.listMyBookings(T, 'customer');
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/services/bookings/my-bookings?role=customer', opts: { token: T } });
    await servicesApi.listMyBookings(T, 'host');
    expect(lastCall().path).toBe('/services/bookings/my-bookings?role=host');
    await servicesApi.getBooking(T, B);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/services/bookings/${B}`, opts: { token: T } });
    await servicesApi.getBookingHistory(T, B);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/services/bookings/${B}/history`, opts: { token: T } });
    await servicesApi.updateBookingStatus(T, B, { status: 'confirmed', vendorNotes: undefined });
    expect(lastCall()).toMatchObject({ method: 'PUT', path: `/services/bookings/${B}/status`, opts: { token: T, body: { status: 'confirmed' } } });
    expect(lastCall().opts.body).not.toHaveProperty('vendorNotes');
    await servicesApi.updateBookingStatus(T, B, { vendorNotes: 'Bring the long board' });
    expect(lastCall().opts.body).toEqual({ vendorNotes: 'Bring the long board' });
  });

  it('getBookingWithHistory merges booking + history and tolerates a failed history fetch', async () => {
    mockBackendRequest.mockImplementation(async (_m: string, path: string) => (path.endsWith('/history') ? [{ to: 'pending' }] : { id: B, status: 'pending' }));
    expect(await servicesApi.getBookingWithHistory(T, B, true)).toEqual({ ok: true, data: { booking: { id: B, status: 'pending' }, history: [{ to: 'pending' }] } });
    expect(await servicesApi.getBookingWithHistory(T, B, false)).toEqual({ ok: true, data: { booking: { id: B, status: 'pending' } } });
    for (const c of mockBackendRequest.mock.calls) expect(c[2]).toMatchObject({ token: T });
    mockBackendRequest.mockImplementation(async (_m: string, path: string) => {
      if (path.endsWith('/history')) throw new BackendApiError(403, 'not a party');
      return { id: B };
    });
    expect(await servicesApi.getBookingWithHistory(T, B, true)).toEqual({ ok: true, data: { booking: { id: B }, history: null, historyError: 'not a party' } });
    mockBackendRequest.mockRejectedValue(new BackendApiError(404, 'Booking not found'));
    expect(await servicesApi.getBookingWithHistory(T, B, true)).toEqual({ ok: false, error: 'Booking not found', status: 404 });
  });

  it('posts reviews and manages the vendor catalogue on the /services routes', async () => {
    await servicesApi.createReview(T, { serviceId: S, rating: 5, comment: undefined });
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/services/reviews', opts: { token: T, body: { serviceId: S, rating: 5 } } });
    expect(lastCall().opts.body).not.toHaveProperty('comment');
    await servicesApi.createService(T, { title: 'Kite lesson', description: 'd', price: 80, priceUnit: 'hourly', category: 'training', location: undefined, imageUrls: [BLOB] });
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/services', opts: { token: T, body: { title: 'Kite lesson', description: 'd', price: 80, priceUnit: 'hourly', category: 'training', imageUrls: [BLOB] } } });
    expect(lastCall().opts.body).not.toHaveProperty('location');
    expect(lastCall().opts.body).not.toHaveProperty('status');
    await servicesApi.updateService(T, S, { status: 'published', price: undefined });
    expect(lastCall()).toMatchObject({ method: 'PUT', path: `/services/${S}`, opts: { token: T, body: { status: 'published' } } });
    expect(Object.keys(lastCall().opts.body)).toEqual(['status']);
    await servicesApi.deleteService(T, S);
    expect(lastCall()).toMatchObject({ method: 'DELETE', path: `/services/${S}`, opts: { token: T } });
    expect(lastCall().opts.body).toBeUndefined();
  });

  it('listMyServices scans the public browse and keeps only rows hosted by the caller', async () => {
    mockBackendRequest.mockImplementation(async (_m: string, path: string) => {
      if (path === '/services?limit=100&page=1') {
        return { data: [{ id: 'a', hostId: ME }, { id: 'b', hostId: OTHER }, { id: 'c', hostId: OTHER, host: { id: ME } }], total: 4, page: 1, limit: 100 };
      }
      if (path === '/services?limit=100&page=2') return { data: [{ id: 'd', hostId: ME }], total: 4, page: 2, limit: 100 };
      throw new Error(`unexpected ${path}`);
    });
    // The first page only holds 3 of the 4 total rows, so the scan continues to page 2 and then stops.
    const res = await servicesApi.listMyServices(ME);
    expect(res).toEqual({ ok: true, data: { services: [{ id: 'a', hostId: ME }, { id: 'c', hostId: OTHER, host: { id: ME } }, { id: 'd', hostId: ME }], scanned: 4, total: 4, truncated: false } });
    expect(mockBackendRequest.mock.calls.map((c) => c[1])).toEqual(['/services?limit=100&page=1', '/services?limit=100&page=2']);
    for (const c of mockBackendRequest.mock.calls) expect(c[2]?.token).toBeUndefined();
  });

  it('listMyServices stops on an empty page, caps the scan, and surfaces backend errors', async () => {
    mockBackendRequest.mockResolvedValue({ data: [], total: 10 });
    expect(await servicesApi.listMyServices(ME)).toEqual({ ok: true, data: { services: [], scanned: 0, total: 10, truncated: true } });
    expect(mockBackendRequest).toHaveBeenCalledTimes(1);
    mockBackendRequest.mockReset();
    mockBackendRequest.mockResolvedValue({ data: [{ id: 'x', hostId: OTHER }], total: 1000 });
    expect(await servicesApi.listMyServices(ME)).toEqual({ ok: true, data: { services: [], scanned: 5, total: 1000, truncated: true } });
    expect(mockBackendRequest).toHaveBeenCalledTimes(5);
    mockBackendRequest.mockReset();
    mockBackendRequest.mockResolvedValue({ nope: true });
    expect(await servicesApi.listMyServices(ME)).toEqual({ ok: true, data: { services: [], scanned: 0, total: 0, truncated: false } });
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(503, 'maintenance'));
    expect(await servicesApi.listMyServices(ME)).toEqual({ ok: false, error: 'maintenance', status: 503 });
  });

  it('returns an error Result (never throws) when the backend rejects', async () => {
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(400, 'Cannot book a service that is not published'));
    expect(await servicesApi.createBooking(T, { serviceId: S, scheduledAt: FUTURE })).toEqual({ ok: false, error: 'Cannot book a service that is not published', status: 400 });
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(403, 'You are not authorized to delete this service'));
    expect(await servicesApi.deleteService(T, S)).toEqual({ ok: false, error: 'You are not authorized to delete this service', status: 403 });
    mockBackendRequest.mockRejectedValueOnce(new Error('net'));
    expect((await servicesApi.searchServices({})).ok).toBe(false);
  });

  it('mirrors the backend enums and media host allow-list', () => {
    expect(SERVICE_CATEGORIES).toEqual(['maintenance', 'cleaning', 'setup', 'training', 'delivery', 'other']);
    expect(SERVICE_PRICE_UNITS).toEqual(['hourly', 'per_job']);
    expect(SERVICE_STATUSES).toEqual(['draft', 'published', 'archived']);
    expect(SERVICE_BOOKING_STATUSES).toEqual(['pending', 'confirmed', 'cancelled', 'completed', 'refunded']);
    expect(SERVICE_HOST_ACTIONS).toEqual(['confirm', 'complete']);
    expect(SERVICE_BOOKING_ACTION_STATUS).toEqual({ confirm: 'confirmed', complete: 'completed', cancel: 'cancelled' });
    expect(isAllowedServiceMediaUrl(BLOB)).toBe(true);
    expect(isAllowedServiceMediaUrl('https://images.unsplash.com/photo-1.jpg')).toBe(true);
    expect(isAllowedServiceMediaUrl('https://Res.Cloudinary.com/x/y.mp4')).toBe(true);
    expect(isAllowedServiceMediaUrl('http://images.unsplash.com/photo-1.jpg')).toBe(false);
    expect(isAllowedServiceMediaUrl('https://evilpublic.blob.vercel-storage.com/x.jpg')).toBe(false);
    expect(isAllowedServiceMediaUrl('https://unsplash.com.evil.example/x.jpg')).toBe(false);
    expect(isAllowedServiceMediaUrl('https://example.com/x.jpg')).toBe(false);
    expect(isAllowedServiceMediaUrl('not a url')).toBe(false);
    expect(isAllowedServiceMediaUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('service tool defs', () => {
  it('exports the service tool set with docs, access, scope and annotations on every def', () => {
    expect(serviceTools.map((t) => t.name)).toEqual([
      'search_services',
      'get_service_details',
      'book_service',
      'list_my_service_bookings',
      'get_service_booking',
      'cancel_service_booking',
      'review_service',
      'update_service_booking_status',
      'list_my_services',
      'create_service',
      'update_service',
      'delete_service',
    ]);
    for (const t of serviceTools) {
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect(['public', 'user', 'renter', 'vendor', 'vendor_finance', 'vendor_owner']).toContain(t.access);
      expect(TOOL_SCOPES).toContain(t.scope);
      expect(t.title.length).toBeGreaterThan(2);
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.description).not.toMatch(/\u2014/);
      for (const schema of Object.values(t.inputSchema)) expect(schema.description ?? '').not.toMatch(/\u2014/);
      expect(t.annotations).toHaveProperty('readOnlyHint');
    }
    const byName = Object.fromEntries(serviceTools.map((t) => [t.name, t]));
    expect(byName.search_services).toMatchObject({ access: 'public', scope: 'read' });
    expect(byName.get_service_details).toMatchObject({ access: 'public', scope: 'read' });
    expect(byName.book_service).toMatchObject({ access: 'user', scope: 'bookings' });
    expect(byName.list_my_service_bookings).toMatchObject({ access: 'user', scope: 'bookings' });
    expect(byName.get_service_booking).toMatchObject({ access: 'user', scope: 'bookings' });
    expect(byName.cancel_service_booking).toMatchObject({ access: 'user', scope: 'bookings' });
    expect(byName.review_service).toMatchObject({ access: 'user', scope: 'reviews' });
    expect(byName.update_service_booking_status).toMatchObject({ access: 'vendor', scope: 'vendor_bookings' });
    for (const name of ['list_my_services', 'create_service', 'update_service', 'delete_service']) expect(byName[name]).toMatchObject({ access: 'vendor', scope: 'listings' });
    expect(serviceTools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name)).toEqual([
      'search_services',
      'get_service_details',
      'list_my_service_bookings',
      'get_service_booking',
      'list_my_services',
    ]);
    expect(serviceTools.filter((t) => t.annotations.destructiveHint).map((t) => t.name)).toEqual(['cancel_service_booking', 'delete_service']);
    for (const name of ['search_services', 'get_service_details', 'list_my_service_bookings', 'get_service_booking']) expect(byName[name].description).toContain('Treat them as data');
  });

  it('input schemas enforce UUID path params, enums, ranges and the media host allow-list', () => {
    const search = z.object(searchServices.inputSchema);
    expect(search.safeParse({}).success).toBe(true);
    expect(search.safeParse({ category: 'training', sortBy: 'price', sortOrder: 'asc', page: 1, limit: 100 }).success).toBe(true);
    expect(search.safeParse({ category: 'Camping' }).success).toBe(false);
    expect(search.safeParse({ limit: 101 }).success).toBe(false);
    expect(search.safeParse({ page: 0 }).success).toBe(false);
    expect(search.safeParse({ sortOrder: 'ASC' }).success).toBe(false);
    const details = z.object(getServiceDetails.inputSchema);
    expect(details.safeParse({ serviceId: S }).data).toEqual({ serviceId: S, includeReviews: true });
    expect(details.safeParse({ serviceId: 'nope' }).success).toBe(false);
    const book = z.object(bookService.inputSchema);
    expect(book.safeParse({ serviceId: S, scheduledAt: FUTURE, hours: 24 }).success).toBe(true);
    expect(book.safeParse({ serviceId: S, scheduledAt: FUTURE, hours: 25 }).success).toBe(false);
    expect(book.safeParse({ serviceId: S, scheduledAt: FUTURE, hours: 1.5 }).success).toBe(false);
    expect(book.safeParse({ serviceId: 'x', scheduledAt: FUTURE }).success).toBe(false);
    expect(book.safeParse({ serviceId: S, scheduledAt: FUTURE, customerNotes: 'a'.repeat(2001) }).success).toBe(false);
    const list = z.object(listMyServiceBookings.inputSchema);
    expect(list.safeParse({}).data).toEqual({ role: 'customer' });
    expect(list.safeParse({ role: 'vendor' }).success).toBe(false);
    expect(list.safeParse({ role: 'host', status: 'refunded' }).success).toBe(true);
    expect(z.object(getServiceBooking.inputSchema).safeParse({ bookingId: B }).data).toEqual({ bookingId: B, includeHistory: false });
    expect(z.object(cancelServiceBooking.inputSchema).safeParse({ bookingId: 'x' }).success).toBe(false);
    const review = z.object(reviewService.inputSchema);
    expect(review.safeParse({ serviceId: S, rating: 5 }).success).toBe(true);
    expect(review.safeParse({ serviceId: S, rating: 0 }).success).toBe(false);
    expect(review.safeParse({ serviceId: S, rating: 4.5 }).success).toBe(false);
    expect(review.safeParse({ serviceId: S, rating: 3, comment: 'a'.repeat(2001) }).success).toBe(false);
    const status = z.object(updateServiceBookingStatus.inputSchema);
    expect(status.safeParse({ bookingId: B, action: 'confirm' }).success).toBe(true);
    expect(status.safeParse({ bookingId: B, action: 'cancel' }).success).toBe(false);
    expect(status.safeParse({ bookingId: B, action: 'refund' }).success).toBe(false);
    const create = z.object(createService.inputSchema);
    expect(create.safeParse({ title: 't', description: 'd', price: 50, category: 'delivery' }).success).toBe(true);
    expect(create.safeParse({ title: 't', description: 'd', price: 50 }).success).toBe(false);
    expect(create.safeParse({ title: 't', description: 'd', price: -1, category: 'delivery' }).success).toBe(false);
    expect(create.safeParse({ title: 't', description: 'd', price: 5, category: 'delivery', priceUnit: 'daily' }).success).toBe(false);
    expect(create.safeParse({ title: 't', description: 'd', price: 5, category: 'delivery', imageUrls: [BLOB, 'https://images.unsplash.com/a.jpg'] }).success).toBe(true);
    expect(create.safeParse({ title: 't', description: 'd', price: 5, category: 'delivery', imageUrls: ['https://evil.example/a.jpg'] }).success).toBe(false);
    expect(create.safeParse({ title: 't', description: 'd', price: 5, category: 'delivery', videoUrls: ['http://images.unsplash.com/a.mp4'] }).success).toBe(false);
    expect(create.safeParse({ title: 't', description: 'd', price: 5, category: 'delivery', latitude: 91 }).success).toBe(false);
    expect(create.shape.title.description).toMatch(/title/i);
    expect(create.shape.title.isOptional()).toBe(false);
    const update = z.object(updateService.inputSchema);
    expect(update.safeParse({ serviceId: S, status: 'published' }).success).toBe(true);
    expect(update.safeParse({ serviceId: S, status: 'live' }).success).toBe(false);
    expect(update.safeParse({ serviceId: 'x', title: 't' }).success).toBe(false);
    expect(update.shape.title.isOptional()).toBe(true);
    expect(update.shape.title.description).toMatch(/title/i);
    expect(z.object(deleteService.inputSchema).safeParse({ serviceId: 'x' }).success).toBe(false);
    expect(z.object(listMyServices.inputSchema).safeParse({}).success).toBe(true);
  });

  it('search_services maps the query, uppercases sortOrder and summarizes the page', async () => {
    mockBackendRequest.mockResolvedValue({ data: [{ id: S }], total: 7, page: 2, limit: 1 });
    const res = await searchServices.handler({ search: 'lesson', sortBy: 'averageRating', sortOrder: 'asc', page: 2, limit: 1 }, publicCtx);
    // Query keys keep the schema order; the handler appends the uppercased sortOrder last.
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/services?search=lesson&sortBy=averageRating&page=2&limit=1&sortOrder=ASC' });
    expect(lastCall().opts.token).toBeUndefined();
    expect(JSON.parse(text(res))).toEqual({ count: 1, total: 7, page: 2, limit: 1, services: [{ id: S }] });
    const calls = mockBackendRequest.mock.calls.length;
    const bad = await searchServices.handler({ minPrice: 100, maxPrice: 10 }, publicCtx);
    expect(bad.isError).toBe(true);
    expect(mockBackendRequest.mock.calls.length).toBe(calls);
    mockBackendRequest.mockResolvedValue({ nope: 1 });
    expect(JSON.parse(text(await searchServices.handler({}, publicCtx)))).toEqual({ count: 0, total: 0, page: 1, limit: 10, services: [] });
  });

  it('get_service_details returns the service with reviews by default and a not-found hint on 404', async () => {
    mockBackendRequest.mockImplementation(async (_m: string, path: string) => (path.endsWith('/reviews') ? [{ id: 'r1', rating: 5 }] : { id: S, priceUnit: 'hourly' }));
    const res = await getServiceDetails.handler({ serviceId: S, includeReviews: true }, publicCtx);
    expect(JSON.parse(text(res))).toEqual({ service: { id: S, priceUnit: 'hourly' }, reviews: [{ id: 'r1', rating: 5 }] });
    mockBackendRequest.mockRejectedValue(new BackendApiError(404, `Service with ID ${S} not found`));
    const missing = await getServiceDetails.handler({ serviceId: S, includeReviews: false }, publicCtx);
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/^Not found: /);
  });

  it('book_service validates the date, requires hours for hourly services, drops hours for per_job and forwards the DTO body', async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    expect((await bookService.handler({ serviceId: S, scheduledAt: past }, userCtx)).isError).toBe(true);
    expect((await bookService.handler({ serviceId: S, scheduledAt: 'next tuesday' }, userCtx)).isError).toBe(true);
    expect(mockBackendRequest).not.toHaveBeenCalled();

    mockBackendRequest.mockImplementation(async (_m: string, path: string) => (path === `/services/${S}` ? { id: S, priceUnit: 'hourly', price: 80 } : { id: B, status: 'pending', totalPrice: 160 }));
    const noHours = await bookService.handler({ serviceId: S, scheduledAt: FUTURE }, userCtx);
    expect(noHours.isError).toBe(true);
    expect(text(noHours)).toMatch(/hours/);
    expect(mockBackendRequest.mock.calls.map((c) => c[1])).toEqual([`/services/${S}`]);

    const booked = await bookService.handler({ serviceId: S, scheduledAt: FUTURE, hours: 2, customerNotes: 'Beginner' }, userCtx);
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/services/bookings', opts: { token: T, body: { serviceId: S, scheduledAt: FUTURE, hours: 2, customerNotes: 'Beginner' } } });
    expect(JSON.parse(text(booked))).toMatchObject({ booking: { id: B, status: 'pending', totalPrice: 160 }, nextStep: expect.stringMatching(/pending until the host confirms/) });

    mockBackendRequest.mockImplementation(async (_m: string, path: string) => (path === `/services/${S}` ? { id: S, priceUnit: 'per_job', price: 120 } : { id: B, status: 'pending' }));
    await bookService.handler({ serviceId: S, scheduledAt: FUTURE, hours: 3 }, userCtx);
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/services/bookings', opts: { token: T, body: { serviceId: S, scheduledAt: FUTURE } } });
    expect(lastCall().opts.body).not.toHaveProperty('hours');
    // The public pre-read never carries the user's token; the booking POST always does.
    expect(mockBackendRequest.mock.calls.find((c) => c[1] === `/services/${S}`)?.[2]?.token).toBeUndefined();

    mockBackendRequest.mockReset();
    mockBackendRequest.mockRejectedValue(new BackendApiError(404, `Service with ID ${S} not found`));
    const gone = await bookService.handler({ serviceId: S, scheduledAt: FUTURE, hours: 1 }, userCtx);
    expect(gone.isError).toBe(true);
    expect(text(gone)).toMatch(/^Not found: /);
    expect(mockBackendRequest.mock.calls.map((c) => c[1])).toEqual([`/services/${S}`]);
  });

  it('list_my_service_bookings passes the role and filters by status client-side', async () => {
    mockBackendRequest.mockResolvedValue([{ id: 'a', status: 'pending' }, { id: 'b', status: 'completed' }, null]);
    const res = await listMyServiceBookings.handler({ role: 'host', status: 'completed' }, vendorCtx);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/services/bookings/my-bookings?role=host', opts: { token: T } });
    expect(JSON.parse(text(res))).toEqual({ role: 'host', count: 1, bookings: [{ id: 'b', status: 'completed' }] });
    const all = await listMyServiceBookings.handler({ role: 'customer' }, userCtx);
    expect(lastCall().path).toBe('/services/bookings/my-bookings?role=customer');
    expect(JSON.parse(text(all))).toMatchObject({ role: 'customer', count: 3 });
    mockBackendRequest.mockResolvedValue({ unexpected: true });
    expect(JSON.parse(text(await listMyServiceBookings.handler({ role: 'customer' }, userCtx)))).toEqual({ role: 'customer', count: 0, bookings: [] });
  });

  it('get_service_booking reads the booking and optionally its timeline', async () => {
    mockBackendRequest.mockImplementation(async (_m: string, path: string) => (path.endsWith('/history') ? [{ from: null, to: 'pending' }] : { id: B }));
    const plain = await getServiceBooking.handler({ bookingId: B, includeHistory: false }, userCtx);
    expect(JSON.parse(text(plain))).toEqual({ booking: { id: B } });
    expect(mockBackendRequest.mock.calls.map((c) => c[1])).toEqual([`/services/bookings/${B}`]);
    const withHistory = await getServiceBooking.handler({ bookingId: B, includeHistory: true }, userCtx);
    expect(JSON.parse(text(withHistory))).toEqual({ booking: { id: B }, history: [{ from: null, to: 'pending' }] });
    for (const c of mockBackendRequest.mock.calls) expect(c[2]).toMatchObject({ token: T });
  });

  it('cancel_service_booking sends status cancelled and surfaces lifecycle errors', async () => {
    await cancelServiceBooking.handler({ bookingId: B }, userCtx);
    expect(lastCall()).toMatchObject({ method: 'PUT', path: `/services/bookings/${B}/status`, opts: { token: T, body: { status: 'cancelled' } } });
    expect(Object.keys(lastCall().opts.body)).toEqual(['status']);
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(400, "Cannot change a service booking from 'completed' to 'cancelled': 'completed' is a terminal state."));
    const illegal = await cancelServiceBooking.handler({ bookingId: B }, userCtx);
    expect(illegal.isError).toBe(true);
    expect(text(illegal)).toMatch(/terminal state/);
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(409, 'This booking was updated by another request. Please reload and try again.'));
    expect(text(await cancelServiceBooking.handler({ bookingId: B }, userCtx))).toMatch(/^Conflict: /);
  });

  it('update_service_booking_status maps actions to statuses, allows notes-only updates and refuses empty calls', async () => {
    const empty = await updateServiceBookingStatus.handler({ bookingId: B }, vendorCtx);
    expect(empty.isError).toBe(true);
    expect(mockBackendRequest).not.toHaveBeenCalled();
    await updateServiceBookingStatus.handler({ bookingId: B, action: 'confirm' }, vendorCtx);
    expect(lastCall()).toMatchObject({ method: 'PUT', path: `/services/bookings/${B}/status`, opts: { token: T, body: { status: 'confirmed' } } });
    expect(lastCall().opts.body).not.toHaveProperty('vendorNotes');
    await updateServiceBookingStatus.handler({ bookingId: B, action: 'complete', vendorNotes: 'Delivered on time' }, vendorCtx);
    expect(lastCall().opts.body).toEqual({ status: 'completed', vendorNotes: 'Delivered on time' });
    await updateServiceBookingStatus.handler({ bookingId: B, vendorNotes: 'Customer prefers mornings' }, vendorCtx);
    expect(lastCall().opts.body).toEqual({ vendorNotes: 'Customer prefers mornings' });
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(403, "Not allowed to set booking status to 'confirmed'"));
    expect(text(await updateServiceBookingStatus.handler({ bookingId: B, action: 'confirm' }, userCtx))).toMatch(/^Not allowed for this account: /);
  });

  it('review_service trims the comment, drops an empty one and forwards the DTO body', async () => {
    await reviewService.handler({ serviceId: S, rating: 5, comment: '  Great guide!  ' }, userCtx);
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/services/reviews', opts: { token: T, body: { serviceId: S, rating: 5, comment: 'Great guide!' } } });
    await reviewService.handler({ serviceId: S, rating: 4, comment: '   ' }, userCtx);
    expect(lastCall().opts.body).toEqual({ serviceId: S, rating: 4 });
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(400, 'You can only review services you have completed'));
    const notEligible = await reviewService.handler({ serviceId: S, rating: 5 }, userCtx);
    expect(notEligible.isError).toBe(true);
    expect(text(notEligible)).toMatch(/only review services you have completed/);
  });

  it('list_my_services needs the caller id from the token and summarizes the owned rows', async () => {
    const anonymous = await listMyServices.handler({}, { role: 'vendor', token: T, kind: 'oauth' } as ToolContext);
    expect(anonymous.isError).toBe(true);
    expect(mockBackendRequest).not.toHaveBeenCalled();
    mockBackendRequest.mockResolvedValue({ data: [{ id: 'mine', hostId: ME }, { id: 'theirs', hostId: OTHER }], total: 2 });
    const res = await listMyServices.handler({}, vendorCtx);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/services?limit=100&page=1' });
    expect(JSON.parse(text(res))).toEqual({ count: 1, services: [{ id: 'mine', hostId: ME }], truncated: false });
  });

  it('create_service trims text, requires paired coordinates and posts only DTO fields', async () => {
    const lonely = await createService.handler({ title: 't', description: 'd', price: 10, category: 'setup', latitude: 45.7 }, vendorCtx);
    expect(lonely.isError).toBe(true);
    expect(mockBackendRequest).not.toHaveBeenCalled();
    mockBackendRequest.mockResolvedValue({ id: S, status: 'draft' });
    const res = await createService.handler(
      { title: '  Kite lesson  ', description: ' Two hours on the water ', price: 80, priceUnit: 'hourly', category: 'training', location: 'Hood River, OR', latitude: 45.7, longitude: -121.5, imageUrls: [BLOB] },
      vendorCtx,
    );
    expect(lastCall()).toMatchObject({
      method: 'POST',
      path: '/services',
      opts: { token: T, body: { title: 'Kite lesson', description: 'Two hours on the water', price: 80, priceUnit: 'hourly', category: 'training', location: 'Hood River, OR', latitude: 45.7, longitude: -121.5, imageUrls: [BLOB] } },
    });
    expect(Object.keys(lastCall().opts.body).sort()).toEqual(['category', 'description', 'imageUrls', 'latitude', 'location', 'longitude', 'price', 'priceUnit', 'title']);
    expect(JSON.parse(text(res))).toEqual({ id: S, status: 'draft' });
  });

  it('update_service requires a field, checks coordinates and forwards status changes to the host route', async () => {
    const empty = await updateService.handler({ serviceId: S }, vendorCtx);
    expect(empty.isError).toBe(true);
    expect((await updateService.handler({ serviceId: S, longitude: 1 }, vendorCtx)).isError).toBe(true);
    expect(mockBackendRequest).not.toHaveBeenCalled();
    await updateService.handler({ serviceId: S, status: 'published' }, vendorCtx);
    expect(lastCall()).toMatchObject({ method: 'PUT', path: `/services/${S}`, opts: { token: T, body: { status: 'published' } } });
    expect(Object.keys(lastCall().opts.body)).toEqual(['status']);
    await updateService.handler({ serviceId: S, price: 95, priceUnit: 'per_job', videoUrls: [] }, vendorCtx);
    expect(lastCall().opts.body).toEqual({ price: 95, priceUnit: 'per_job', videoUrls: [] });
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(403, 'You are not authorized to update this service'));
    expect(text(await updateService.handler({ serviceId: S, title: 'x' }, vendorCtx))).toMatch(/^Not allowed for this account: /);
  });

  it('delete_service maps the 204 to a confirmation and surfaces backend refusals', async () => {
    mockBackendRequest.mockResolvedValue(undefined);
    const res = await deleteService.handler({ serviceId: S }, vendorCtx);
    expect(lastCall()).toMatchObject({ method: 'DELETE', path: `/services/${S}`, opts: { token: T } });
    expect(JSON.parse(text(res))).toEqual({ deleted: true, serviceId: S });
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(404, `Service with ID ${S} not found`));
    const missing = await deleteService.handler({ serviceId: S }, vendorCtx);
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/^Not found: /);
  });
});
