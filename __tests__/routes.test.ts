/** Contract tests for the routes backend module and tool defs: exact backend method/path/body/token per call. */
export {};

const mockBackendRequest = jest.fn();
jest.mock('../src/lib/backend-client', () => {
  class BackendApiError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.name = 'BackendApiError'; this.status = status; }
  }
  return {
    BackendApiError,
    backendRequest: (...args: unknown[]) => mockBackendRequest(...args),
    backendBaseUrl: () => 'https://api.test/api/v1',
  };
});

import {
  routesApi,
  geometryError,
  summarizeDraft,
  MAX_GPX_BYTES,
  MAX_LINKED_ROUTES_PER_LISTING,
  ROUTE_ACTIVITY_TYPES,
} from '../src/tools/routes';
import { routeTools, deleteRoute, getPublicRoute, setListingRoutes, createRoute, updateRoute, importGpxRoute, updateListingRoute } from '../src/tools/defs/routes';
import type { ToolContext } from '../src/tools/registry';

const T = 'h.p.s';
const { BackendApiError } = jest.requireMock('../src/lib/backend-client');
const L = '11111111-1111-4111-8111-111111111111';
const R1 = '22222222-2222-4222-8222-222222222222';
const R2 = '33333333-3333-4333-8333-333333333333';
const R3 = '44444444-4444-4444-8444-444444444444';
const vendorCtx: ToolContext = { userId: 'u', role: 'vendor', token: T, kind: 'oauth' };

const GPX = '<?xml version="1.0"?><gpx version="1.1"><trk><name>Ridge</name><trkseg><trkpt lat="47.6" lon="-122.3"/><trkpt lat="47.7" lon="-122.4"/></trkseg></trk></gpx>';

function lastCall() {
  const c = mockBackendRequest.mock.calls[mockBackendRequest.mock.calls.length - 1];
  return { method: c[0], path: c[1], opts: c[2] ?? {} };
}

function text(result: { content: Array<{ type: string; text?: string }>; isError?: boolean }) {
  return result.content[0]?.text ?? '';
}

const mockFetch = jest.fn();
function makeResponse(ok: boolean, status: number, body: unknown) {
  return { ok, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}

beforeEach(() => {
  mockBackendRequest.mockReset();
  mockBackendRequest.mockResolvedValue({ ok: 1 });
  mockFetch.mockReset();
  (global as unknown as { fetch: jest.Mock }).fetch = mockFetch;
});

describe('routesApi: library', () => {
  it('lists mine (active only by default, includeArchived as the literal string true)', async () => {
    await routesApi.listMine(T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/routes/mine', opts: { token: T } });
    await routesApi.listMine(T, true);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/routes/mine?includeArchived=true', opts: { token: T } });
    await routesApi.listMine(T, false);
    expect(lastCall().path).toBe('/routes/mine');
  });

  it('reads one route', async () => {
    await routesApi.getOne(T, R1);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/routes/${R1}`, opts: { token: T } });
  });

  it('creates with only the given DTO fields and never a vendorId', async () => {
    await routesApi.create(T, { name: 'Ridge', activityType: 'mtb', geometry: [[-122.3, 47.6], [-122.4, 47.7, 120]], summary: undefined, source: 'drawn' });
    expect(lastCall()).toMatchObject({
      method: 'POST',
      path: '/routes',
      opts: { token: T, body: { name: 'Ridge', activityType: 'mtb', geometry: [[-122.3, 47.6], [-122.4, 47.7, 120]], source: 'drawn' } },
    });
    expect(lastCall().opts.body).not.toHaveProperty('summary');
    expect(lastCall().opts.body).not.toHaveProperty('vendorId');
  });

  it('patches with nulls preserved (revert to computed / clear destination) and undefined dropped', async () => {
    await routesApi.update(T, R1, { difficulty: null, estimatedDurationMinutes: null, destinationId: null, name: undefined, hazards: 'Ice' });
    expect(lastCall()).toMatchObject({
      method: 'PATCH',
      path: `/routes/${R1}`,
      opts: { token: T, body: { difficulty: null, estimatedDurationMinutes: null, destinationId: null, hazards: 'Ice' } },
    });
    expect(lastCall().opts.body).not.toHaveProperty('name');
  });

  it('archives by default and hard-deletes with ?hard=true', async () => {
    await routesApi.remove(T, R1);
    expect(lastCall()).toMatchObject({ method: 'DELETE', path: `/routes/${R1}`, opts: { token: T } });
    await routesApi.remove(T, R1, true);
    expect(lastCall()).toMatchObject({ method: 'DELETE', path: `/routes/${R1}?hard=true`, opts: { token: T } });
  });

  it('surfaces backend errors as Result errors (409 on a linked hard delete)', async () => {
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(409, 'This route is still linked to listings or experiences and cannot be permanently deleted'));
    const res = await routesApi.remove(T, R1, true);
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/still linked/), status: 409 });
    mockBackendRequest.mockRejectedValueOnce(new Error('net'));
    expect((await routesApi.getOne(T, R1)).ok).toBe(false);
  });
});

describe('routesApi: GPX import (multipart)', () => {
  it('posts the GPX as multipart field "file" with a Bearer header and no manual Content-Type', async () => {
    mockFetch.mockResolvedValue(makeResponse(true, 201, { success: true, draft: { name: 'Ridge', geometry: [[1, 2], [3, 4]], preview: { distanceM: 5 } } }));
    const res = await routesApi.importGpx(T, GPX);
    expect(res).toEqual({ ok: true, data: { success: true, draft: { name: 'Ridge', geometry: [[1, 2], [3, 4]], preview: { distanceM: 5 } } } });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.test/api/v1/routes/import/gpx');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: `Bearer ${T}` });
    expect(init.signal).toBeDefined();
    expect(init.body).toBeInstanceOf(FormData);
    const file = init.body.get('file') as Blob & { name?: string };
    expect(file).toBeInstanceOf(Blob);
    expect(file.type).toBe('application/gpx+xml');
    expect(file.name).toBe('route.gpx');
    expect(await file.text()).toBe(GPX);
    expect(mockBackendRequest).not.toHaveBeenCalled();
  });

  it('rejects oversized files locally without calling the backend', async () => {
    const huge = 'x'.repeat(MAX_GPX_BYTES + 1);
    expect(await routesApi.importGpx(T, huge)).toEqual({ ok: false, error: expect.stringMatching(/2 MB/), status: 413 });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('maps backend error shapes, network failures and timeouts', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(false, 400, { statusCode: 400, message: ['No track found in GPX file', 'bad'] }));
    expect(await routesApi.importGpx(T, GPX)).toEqual({ ok: false, error: 'No track found in GPX file; bad', status: 400 });
    mockFetch.mockResolvedValueOnce(makeResponse(false, 413, { statusCode: 413, message: 'GPX file must be 2MB or smaller' }));
    expect(await routesApi.importGpx(T, GPX)).toEqual({ ok: false, error: 'GPX file must be 2MB or smaller', status: 413 });
    mockFetch.mockResolvedValueOnce(makeResponse(false, 502, 'not json'));
    expect(await routesApi.importGpx(T, GPX)).toEqual({ ok: false, error: 'Backend request failed (502)', status: 502 });
    mockFetch.mockRejectedValueOnce(new Error('ECONNRESET'));
    expect(await routesApi.importGpx(T, GPX)).toMatchObject({ ok: false, status: 502 });
    const timeout = new Error('t');
    timeout.name = 'TimeoutError';
    mockFetch.mockRejectedValueOnce(timeout);
    expect(await routesApi.importGpx(T, GPX)).toMatchObject({ ok: false, status: 504 });
  });

  it('importGpxAsRoute parses then POSTs /routes with the draft geometry, source gpx and the overrides', async () => {
    mockFetch.mockResolvedValue(makeResponse(true, 201, {
      success: true,
      draft: { name: 'From GPX', geometry: [[-122.3, 47.6], [-122.4, 47.7]], cuePoints: null, pois: null, surface: null, unpavedPct: null, source: 'gpx', sourceRef: null, preview: { distanceM: 1234 } },
    }));
    mockBackendRequest.mockResolvedValue({ success: true, route: { id: R1 } });
    const res = await routesApi.importGpxAsRoute(T, GPX, { activityType: 'gravel', surface: 'mixed', difficulty: 'moderate', name: undefined });
    expect(res).toEqual({ ok: true, data: { success: true, route: { id: R1 }, import: { pointCount: 2, preview: { distanceM: 1234 } } } });
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/routes', opts: { token: T } });
    expect(lastCall().opts.body).toEqual({
      name: 'From GPX',
      activityType: 'gravel',
      geometry: [[-122.3, 47.6], [-122.4, 47.7]],
      surface: 'mixed',
      difficulty: 'moderate',
      source: 'gpx',
    });

    mockBackendRequest.mockClear();
    await routesApi.importGpxAsRoute(T, GPX, { activityType: 'hike', name: 'Renamed' });
    expect(lastCall().opts.body).toMatchObject({ name: 'Renamed', activityType: 'hike', source: 'gpx' });
  });

  it('importGpxAsRoute stops on a parse failure or an unusable draft', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(false, 400, { message: 'Could not parse GPX file: invalid XML' }));
    expect(await routesApi.importGpxAsRoute(T, GPX, { activityType: 'hike' })).toEqual({ ok: false, error: 'Could not parse GPX file: invalid XML', status: 400 });
    mockFetch.mockResolvedValueOnce(makeResponse(true, 201, { success: true, draft: { name: 'x', geometry: [] } }));
    expect(await routesApi.importGpxAsRoute(T, GPX, { activityType: 'hike' })).toMatchObject({ ok: false, status: 400 });
    expect(mockBackendRequest).not.toHaveBeenCalled();
  });
});

describe('routesApi: public reads', () => {
  it('reads a shared route by slug without a token and builds the GPX download URL', async () => {
    await routesApi.getPublic('abc123xyz');
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/routes/public/abc123xyz' });
    expect(lastCall().opts.token).toBeUndefined();
    expect(routesApi.publicGpxUrl('abc123xyz')).toBe('https://api.test/api/v1/routes/public/abc123xyz/gpx');
  });

  it('lists a listing\'s routes on the canonical /rentals path, forwarding a token only when present', async () => {
    await routesApi.listListingRoutes(L);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/rentals/${L}/routes` });
    expect(lastCall().opts.token).toBeUndefined();
    await routesApi.listListingRoutes(L, T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/rentals/${L}/routes`, opts: { token: T } });
  });
});

describe('routesApi: listing <-> library links', () => {
  it('PUTs the full ordered routeIds set (and nothing else) to /rentals/:id/routes', async () => {
    await routesApi.setListingRoutes(T, L, [R1, R2]);
    expect(lastCall()).toMatchObject({ method: 'PUT', path: `/rentals/${L}/routes`, opts: { token: T, body: { routeIds: [R1, R2] } } });
    expect(lastCall().opts.body).not.toHaveProperty('vendorId');
    await routesApi.setListingRoutes(T, L, []);
    expect(lastCall().opts.body).toEqual({ routeIds: [] });
  });

  it('attach appends to the current v2 links, ignoring legacy cards, and is a no-op when already attached', async () => {
    mockBackendRequest.mockImplementation(async (method: string) =>
      method === 'GET'
        ? { routes: [{ id: R1, source: 'drawn', shareSlug: 'aaa' }, { id: 'legacy-1', source: 'legacy', shareSlug: null }] }
        : { routes: [{ id: R1 }, { id: R2 }] },
    );
    const res = await routesApi.attachToListing(T, L, R2);
    expect(res).toEqual({ ok: true, data: { attached: true, alreadyAttached: false, routes: [{ id: R1 }, { id: R2 }] } });
    expect(lastCall()).toMatchObject({ method: 'PUT', path: `/rentals/${L}/routes`, opts: { token: T, body: { routeIds: [R1, R2] } } });
    expect(mockBackendRequest.mock.calls[0]).toEqual(['GET', `/rentals/${L}/routes`, { token: T }]);

    mockBackendRequest.mockClear();
    const again = await routesApi.attachToListing(T, L, R1);
    expect(again).toMatchObject({ ok: true, data: { attached: true, alreadyAttached: true } });
    expect(mockBackendRequest).toHaveBeenCalledTimes(1);
    expect(mockBackendRequest.mock.calls[0][0]).toBe('GET');
  });

  it('attach refuses a sixth link locally and propagates read errors', async () => {
    const full = Array.from({ length: MAX_LINKED_ROUTES_PER_LISTING }, (_, i) => ({ id: `r${i}`, source: 'drawn' }));
    mockBackendRequest.mockResolvedValueOnce({ routes: full });
    expect(await routesApi.attachToListing(T, L, R3)).toEqual({ ok: false, error: expect.stringMatching(/at most 5/), status: 400 });
    expect(mockBackendRequest).toHaveBeenCalledTimes(1);
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(404, 'Listing not found'));
    expect(await routesApi.attachToListing(T, L, R3)).toEqual({ ok: false, error: 'Listing not found', status: 404 });
  });

  it('detach removes only the target link, reports wasAttached:false, and redirects legacy cards', async () => {
    mockBackendRequest.mockImplementation(async (method: string) =>
      method === 'GET'
        ? { routes: [{ id: R1, source: 'gpx' }, { id: R2, source: 'drawn' }, { id: R3, source: 'legacy', shareSlug: null }] }
        : { routes: [{ id: R2 }] },
    );
    const res = await routesApi.detachFromListing(T, L, R1);
    expect(res).toEqual({ ok: true, data: { detached: true, wasAttached: true, routes: [{ id: R2 }] } });
    expect(lastCall()).toMatchObject({ method: 'PUT', path: `/rentals/${L}/routes`, opts: { token: T, body: { routeIds: [R2] } } });

    mockBackendRequest.mockClear();
    expect(await routesApi.detachFromListing(T, L, '55555555-5555-4555-8555-555555555555')).toMatchObject({ ok: true, data: { detached: false, wasAttached: false } });
    expect(mockBackendRequest).toHaveBeenCalledTimes(1);

    expect(await routesApi.detachFromListing(T, L, R3)).toEqual({ ok: false, error: expect.stringMatching(/delete_listing_route/), status: 400 });
  });
});

describe('routesApi: legacy per-listing route cards', () => {
  it('creates, updates and deletes on /rentals/:id/routes[/:routeId] with compacted bodies', async () => {
    await routesApi.createListingRoute(T, L, { title: 'Loop', difficulty: 'easy', hazards: ['Ice'], status: undefined });
    expect(lastCall()).toMatchObject({ method: 'POST', path: `/rentals/${L}/routes`, opts: { token: T, body: { title: 'Loop', difficulty: 'easy', hazards: ['Ice'] } } });
    expect(lastCall().opts.body).not.toHaveProperty('status');
    await routesApi.updateListingRoute(T, L, R1, { status: 'published' });
    expect(lastCall()).toMatchObject({ method: 'PUT', path: `/rentals/${L}/routes/${R1}`, opts: { token: T, body: { status: 'published' } } });
    await routesApi.deleteListingRoute(T, L, R1);
    expect(lastCall()).toMatchObject({ method: 'DELETE', path: `/rentals/${L}/routes/${R1}`, opts: { token: T } });
    expect(lastCall().opts.body).toBeUndefined();
  });
});

describe('helpers', () => {
  it('geometryError mirrors the backend tuple rules and reminds about lng-first', () => {
    expect(geometryError([[-122.3, 47.6], [-122.4, 47.7, 10]])).toBeNull();
    // Swapped [lat, lng] input is caught as an out-of-range latitude, with the lng-first reminder.
    expect(geometryError([[47.6, -122.3], [47.7, -122.4]])).toMatch(/geometry\[0\].*latitude.*longitude first/);
    expect(geometryError([[200, 47.6], [1, 1]])).toMatch(/geometry\[0\].*longitude.*longitude first/);
    expect(geometryError([[1, 1], [1, 95]])).toMatch(/geometry\[1\].*latitude/);
    expect(geometryError([[1, 1, Number.NaN], [1, 1]])).toMatch(/elevation/);
    expect(geometryError([[1], [1, 1]])).toMatch(/tuple/);
  });

  it('summarizeDraft drops the geometry but keeps count and endpoints', () => {
    expect(summarizeDraft(undefined)).toBeNull();
    const s = summarizeDraft({ name: 'x', geometry: [[1, 2], [3, 4], [5, 6]], cuePoints: null, pois: null, surface: null, unpavedPct: null, source: 'gpx', sourceRef: null, preview: { distanceM: 9 } });
    expect(s).toEqual({ name: 'x', cuePoints: null, pois: null, surface: null, unpavedPct: null, source: 'gpx', sourceRef: null, preview: { distanceM: 9 }, pointCount: 3, start: [1, 2], end: [5, 6] });
    expect(s).not.toHaveProperty('geometry');
  });
});

describe('routeTools defs', () => {
  it('exports well-formed, uniquely named defs with the expected access/scope split', () => {
    expect(routeTools.length).toBe(14);
    const names = routeTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of routeTools) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]+$/);
      expect(['public', 'user', 'renter', 'vendor', 'vendor_finance', 'vendor_owner']).toContain(t.access);
      expect(['read', 'listings']).toContain(t.scope);
      expect(t.title.length).toBeGreaterThan(2);
      expect(t.description.length).toBeGreaterThanOrEqual(40);
      expect(t.description).not.toMatch(/—/);
      expect(t.annotations).toHaveProperty('readOnlyHint');
      expect(typeof t.handler).toBe('function');
    }
    const publicOnes = routeTools.filter((t) => t.access === 'public').map((t) => t.name).sort();
    expect(publicOnes).toEqual(['get_public_route', 'list_listing_routes']);
    for (const t of routeTools) {
      if (t.access === 'public') expect(t.scope).toBe('read');
      else {
        expect(t.access).toBe('vendor');
        expect(t.scope).toBe('listings');
      }
    }
    const destructive = routeTools.filter((t) => t.annotations.destructiveHint).map((t) => t.name).sort();
    expect(destructive).toEqual(['delete_listing_route', 'delete_route', 'detach_route_from_listing']);
    expect(ROUTE_ACTIVITY_TYPES).toContain('kayak_paddle');
  });

  it('delete_route maps the mode to the hard flag and renders the 204 as a result', async () => {
    mockBackendRequest.mockResolvedValue(undefined);
    const archived = await deleteRoute.handler({ routeId: R1 }, vendorCtx);
    expect(lastCall()).toMatchObject({ method: 'DELETE', path: `/routes/${R1}`, opts: { token: T } });
    expect(JSON.parse(text(archived))).toEqual({ archived: true, routeId: R1 });
    const deleted = await deleteRoute.handler({ routeId: R1, mode: 'delete_permanently' }, vendorCtx);
    expect(lastCall().path).toBe(`/routes/${R1}?hard=true`);
    expect(JSON.parse(text(deleted))).toEqual({ deleted: true, routeId: R1 });
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(409, 'still linked'));
    const conflict = await deleteRoute.handler({ routeId: R1, mode: 'delete_permanently' }, vendorCtx);
    expect(conflict.isError).toBe(true);
    expect(text(conflict)).toMatch(/^Conflict: still linked/);
  });

  it('get_public_route adds the page and GPX download URLs', async () => {
    mockBackendRequest.mockResolvedValue({ route: { id: R1, name: 'Ridge' } });
    const res = await getPublicRoute.handler({ shareSlug: 'abc123xyz' }, { kind: 'operator', role: 'admin' });
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/routes/public/abc123xyz' });
    expect(JSON.parse(text(res))).toEqual({
      route: { id: R1, name: 'Ridge' },
      pageUrl: 'https://go-splitt.com/r/abc123xyz',
      gpxDownloadUrl: 'https://api.test/api/v1/routes/public/abc123xyz/gpx',
    });
  });

  it('validates locally before calling the backend', async () => {
    const dup = await setListingRoutes.handler({ listingId: L, routeIds: [R1, R1] }, vendorCtx);
    expect(dup.isError).toBe(true);
    const badGeom = await createRoute.handler({ name: 'x', activityType: 'hike', geometry: [[200, 0], [0, 0]] }, vendorCtx);
    expect(badGeom.isError).toBe(true);
    expect(text(badGeom)).toMatch(/longitude/);
    const empty = await updateRoute.handler({ routeId: R1 }, vendorCtx);
    expect(empty.isError).toBe(true);
    const emptyLegacy = await updateListingRoute.handler({ listingId: L, routeId: R1 }, vendorCtx);
    expect(emptyLegacy.isError).toBe(true);
    expect(mockBackendRequest).not.toHaveBeenCalled();

    const okGeom = await createRoute.handler({ name: 'x', activityType: 'hike', geometry: [[-122.3, 47.6], [-122.4, 47.7]] }, vendorCtx);
    expect(okGeom.isError).toBeUndefined();
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/routes', opts: { token: T, body: { name: 'x', activityType: 'hike' } } });
  });

  it('import_gpx_route dryRun previews without saving; otherwise saves via /routes', async () => {
    mockFetch.mockResolvedValue(makeResponse(true, 201, { success: true, draft: { name: 'Ridge', geometry: [[1, 2], [3, 4]], preview: { distanceM: 42 } } }));
    const preview = await importGpxRoute.handler({ gpxXml: GPX, activityType: 'mtb', dryRun: true }, vendorCtx);
    expect(mockBackendRequest).not.toHaveBeenCalled();
    expect(JSON.parse(text(preview))).toMatchObject({ saved: false, draft: { name: 'Ridge', pointCount: 2, preview: { distanceM: 42 } } });
    expect(text(preview)).not.toContain('"geometry"');

    mockBackendRequest.mockResolvedValue({ success: true, route: { id: R1 } });
    const saved = await importGpxRoute.handler({ gpxXml: GPX, activityType: 'mtb', name: 'Custom' }, vendorCtx);
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/routes', opts: { token: T, body: { name: 'Custom', activityType: 'mtb', source: 'gpx', geometry: [[1, 2], [3, 4]] } } });
    expect(lastCall().opts.body).not.toHaveProperty('dryRun');
    expect(JSON.parse(text(saved))).toMatchObject({ route: { id: R1 }, import: { pointCount: 2 } });
  });
});
