/** Contract tests for the discovery-extras backend module + tool defs: exact method/path/body/token per call, handler guards. */
export {};

const mockBackendRequest = jest.fn();
jest.mock('../src/lib/backend-client', () => {
  class BackendApiError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.name = 'BackendApiError'; this.status = status; }
  }
  return { BackendApiError, backendRequest: (...args: unknown[]) => mockBackendRequest(...args) };
});

import { discoveryExtrasTools as extras, POI_RECIPES, SEARCH_ALERT_FREQUENCIES } from '../src/tools/discovery-extras';
import {
  discoveryExtrasTools as defs,
  CATEGORY_NAMES,
  listSearchAlerts,
  createSearchAlert,
  updateSearchAlert,
  toggleSearchAlert,
  deleteSearchAlert,
  listSavedTrips,
  saveTrip,
  deleteSavedTrip,
  emailTripPlan,
  planTrip,
  getTripPois,
  getTripIdeasForListing,
  suggestLocations,
  generateAiTripPlan,
  listDestinations,
  getDestination,
  listCategories,
  getCategory,
} from '../src/tools/defs/discovery-extras';
import { TOOL_SCOPES, type ToolContext } from '../src/tools/registry';

const T = 'h.p.s';
const A = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const ctx: ToolContext = { userId: 'u', role: 'renter', token: T, kind: 'oauth' };
const anon: ToolContext = { kind: 'operator' } as ToolContext;
const { BackendApiError } = jest.requireMock('../src/lib/backend-client');

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

describe('discoveryExtrasTools (backend module)', () => {
  it('search alerts: list, get, create (DTO fields only), update, toggle, delete', async () => {
    await extras.listSearchAlerts(T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/search-alerts', opts: { token: T } });
    expect(lastCall().opts.body).toBeUndefined();
    await extras.getSearchAlert(T, A);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/search-alerts/${A}`, opts: { token: T } });
    await extras.createSearchAlert(T, { name: 'Kayaks', searchQuery: 'kayak', category: 'Kayaking', maxPrice: 50, minPrice: undefined, frequency: 'weekly' });
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/search-alerts', opts: { token: T, body: { name: 'Kayaks', searchQuery: 'kayak', category: 'Kayaking', maxPrice: 50, frequency: 'weekly' } } });
    expect(lastCall().opts.body).not.toHaveProperty('minPrice');
    await extras.updateSearchAlert(T, A, { isActive: false, location: undefined });
    expect(lastCall()).toMatchObject({ method: 'PUT', path: `/search-alerts/${A}`, opts: { token: T, body: { isActive: false } } });
    expect(Object.keys(lastCall().opts.body)).toEqual(['isActive']);
    await extras.toggleSearchAlert(T, A);
    expect(lastCall()).toMatchObject({ method: 'POST', path: `/search-alerts/${A}/toggle`, opts: { token: T, body: {} } });
    await extras.deleteSearchAlert(T, A);
    expect(lastCall()).toMatchObject({ method: 'DELETE', path: `/search-alerts/${A}`, opts: { token: T } });
  });

  it('saved trips: list, save (compact body), delete', async () => {
    await extras.listSavedTrips(T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/saved-trips', opts: { token: T } });
    await extras.saveTrip(T, { destination: 'Lake Minnetonka, MN', numPeople: 4, activities: ['Boating'], duration: 3, startDate: undefined, planSnapshot: { source: 'board' } });
    expect(lastCall()).toMatchObject({
      method: 'POST',
      path: '/saved-trips',
      opts: { token: T, body: { destination: 'Lake Minnetonka, MN', numPeople: 4, activities: ['Boating'], duration: 3, planSnapshot: { source: 'board' } } },
    });
    expect(lastCall().opts.body).not.toHaveProperty('startDate');
    await extras.deleteSavedTrip(T, A);
    expect(lastCall()).toMatchObject({ method: 'DELETE', path: `/saved-trips/${A}`, opts: { token: T } });
  });

  it('trip intelligence: plan, pois, ideas, geocode-suggest are public GETs with encoded queries', async () => {
    await extras.planTrip({ destination: 'Lake Minnetonka, MN', activities: ['Boating', 'Water Sports'], start: '2026-07-17', end: '2026-07-19', days: undefined, people: 4 });
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/trips/plan?destination=Lake+Minnetonka%2C+MN&activities=Boating%2CWater+Sports&start=2026-07-17&end=2026-07-19&people=4' });
    expect(lastCall().opts.token).toBeUndefined();
    await extras.planTrip({ destination: 'Moab', activities: ['Biking'], days: 2 });
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/trips/plan?destination=Moab&activities=Biking&days=2' });
    await extras.getTripPois({ lat: 44.9298, lng: -93.5841, recipe: 'food-drink', radius: 12 });
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/trips/pois?lat=44.9298&lng=-93.5841&recipe=food-drink&radius=12' });
    await extras.getTripPois({ lat: 0, lng: 0, recipe: 'camping' });
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/trips/pois?lat=0&lng=0&recipe=camping' });
    await extras.getTripIdeas(L, '2026-07-18', undefined);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/trips/ideas/${L}?start=2026-07-18` });
    await extras.getTripIdeas(L);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/trips/ideas/${L}` });
    await extras.suggestLocations('lake minnet');
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/trips/geocode-suggest?q=lake+minnet' });
    expect(lastCall().opts.token).toBeUndefined();
  });

  it('email-plan forwards the JWT and only DTO fields; AI plan is a public POST with a longer timeout', async () => {
    await extras.emailTripPlan(T, { destination: 'Moab, UT', numPeople: 2, activities: ['Biking'], duration: 3, tripSummary: undefined, source: 'board', gearCategories: [{ category: 'Biking', priority: 'High' }] });
    expect(lastCall()).toMatchObject({
      method: 'POST',
      path: '/trips/email-plan',
      opts: { token: T, body: { destination: 'Moab, UT', numPeople: 2, activities: ['Biking'], duration: 3, source: 'board', gearCategories: [{ category: 'Biking', priority: 'High' }] } },
    });
    expect(lastCall().opts.body).not.toHaveProperty('tripSummary');
    await extras.generateAiTripPlan({ destination: 'Yosemite', duration: 3, numPeople: 2, activities: ['hiking'], experienceLevel: undefined });
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/ai/plan-trip', opts: { body: { destination: 'Yosemite', duration: 3, numPeople: 2, activities: ['hiking'] }, timeoutMs: 25000 } });
    expect(lastCall().opts.token).toBeUndefined();
    expect(lastCall().opts.body).not.toHaveProperty('experienceLevel');
  });

  it('destinations and categories are public GETs; slugs are URL-encoded', async () => {
    await extras.listDestinations();
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/destinations' });
    expect(lastCall().opts.token).toBeUndefined();
    await extras.getDestination('itasca-state-park');
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/destinations/itasca-state-park' });
    await extras.getDestination('a/b?c');
    expect(lastCall().path).toBe('/destinations/a%2Fb%3Fc');
    await extras.listCategories();
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/categories' });
    await extras.listCategories(true);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/categories/stats' });
    await extras.getCategory(C);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/categories/${C}` });
    await extras.getCategoryStats(C);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/categories/${C}/stats` });
  });

  it('returns an error Result (never throws) when the backend rejects', async () => {
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(404, 'Saved trip not found'));
    expect(await extras.deleteSavedTrip(T, A)).toEqual({ ok: false, error: 'Saved trip not found', status: 404 });
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(429, 'Too many requests'));
    expect(await extras.emailTripPlan(T, { destination: 'X', numPeople: 1 })).toEqual({ ok: false, error: 'Too many requests', status: 429 });
    mockBackendRequest.mockRejectedValueOnce(new Error('net'));
    expect((await extras.planTrip({ destination: 'X', activities: ['Biking'] })).ok).toBe(false);
  });
});

describe('discovery-extras tool defs', () => {
  it('exports the tool set with docs, access, scope and annotations on every def', () => {
    expect(defs.map((t) => t.name)).toEqual([
      'list_search_alerts',
      'create_search_alert',
      'update_search_alert',
      'toggle_search_alert',
      'delete_search_alert',
      'list_saved_trips',
      'save_trip',
      'delete_saved_trip',
      'email_trip_plan',
      'plan_trip',
      'get_trip_pois',
      'get_trip_ideas_for_listing',
      'suggest_locations',
      'generate_ai_trip_plan',
      'list_destinations',
      'get_destination',
      'list_categories',
      'get_category',
    ]);
    const publicNames = new Set(['plan_trip', 'get_trip_pois', 'get_trip_ideas_for_listing', 'suggest_locations', 'generate_ai_trip_plan', 'list_destinations', 'get_destination', 'list_categories', 'get_category']);
    for (const t of defs) {
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect(t.access).toBe(publicNames.has(t.name) ? 'public' : 'user');
      expect(t.scope).toBe(publicNames.has(t.name) ? 'read' : 'favorites');
      expect(TOOL_SCOPES).toContain(t.scope);
      expect(t.title.length).toBeGreaterThan(2);
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.description).not.toMatch(/—/);
      expect(t.annotations).toHaveProperty('readOnlyHint');
      for (const field of Object.values(t.inputSchema)) {
        expect(JSON.stringify(field.description ?? '')).not.toMatch(/—/);
      }
    }
    expect(defs.filter((t) => t.annotations.destructiveHint).map((t) => t.name)).toEqual(['delete_search_alert', 'delete_saved_trip']);
    expect(defs.filter((t) => t.annotations.readOnlyHint).map((t) => t.name)).toEqual([
      'list_search_alerts', 'list_saved_trips', 'plan_trip', 'get_trip_pois', 'get_trip_ideas_for_listing', 'suggest_locations', 'generate_ai_trip_plan',
      'list_destinations', 'get_destination', 'list_categories', 'get_category',
    ]);
    expect(defs.find((t) => t.name === 'email_trip_plan')?.annotations.idempotentHint).toBe(false);
    expect(SEARCH_ALERT_FREQUENCIES).toEqual(['instant', 'daily', 'weekly']);
    expect(POI_RECIPES).toEqual(['trails-bike', 'trails-hike', 'food-drink', 'on-water', 'parks-views', 'camping']);
    expect(CATEGORY_NAMES).toEqual(expect.arrayContaining(['Kayaking', 'ATVs', 'Cabins', 'Campsites', 'RV Sites', 'Glamping', 'Other']));
  });

  it('list_search_alerts lists or fetches one, unwrapping the envelope', async () => {
    mockBackendRequest.mockResolvedValueOnce({ success: true, alerts: [{ id: A }] });
    const list = await listSearchAlerts.handler({}, ctx);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/search-alerts', opts: { token: T } });
    expect(JSON.parse(text(list))).toEqual([{ id: A }]);
    mockBackendRequest.mockResolvedValueOnce({ success: true, alert: { id: A, radiusKm: 25 } });
    const one = await listSearchAlerts.handler({ alertId: A }, ctx);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/search-alerts/${A}`, opts: { token: T } });
    expect(JSON.parse(text(one))).toEqual({ id: A, radiusKm: 25 });
  });

  it('create_search_alert requires a criterion, validates prices/geo and trims text', async () => {
    const none = await createSearchAlert.handler({ name: 'Empty' }, ctx);
    expect(none.isError).toBe(true);
    expect(text(none)).toMatch(/at least one criterion/);
    const prices = await createSearchAlert.handler({ name: 'Bad', minPrice: 60, maxPrice: 50 }, ctx);
    expect(text(prices)).toMatch(/minPrice must not exceed maxPrice/);
    const geo = await createSearchAlert.handler({ name: 'Geo', latitude: 44.9 }, ctx);
    expect(text(geo)).toMatch(/both latitude and longitude/);
    const radius = await createSearchAlert.handler({ name: 'R', searchQuery: 'kayak', radiusKm: 10 }, ctx);
    expect(text(radius)).toMatch(/radiusKm needs latitude/);
    expect(mockBackendRequest).not.toHaveBeenCalled();

    mockBackendRequest.mockResolvedValueOnce({ success: true, alert: { id: A, name: 'Kayaks near Austin' } });
    const created = await createSearchAlert.handler({ name: '  Kayaks near Austin ', searchQuery: '  kayak ', category: 'Kayaking', location: 'Austin, TX', maxPrice: 50, frequency: 'daily' }, ctx);
    expect(lastCall()).toMatchObject({
      method: 'POST',
      path: '/search-alerts',
      opts: { token: T, body: { name: 'Kayaks near Austin', searchQuery: 'kayak', category: 'Kayaking', location: 'Austin, TX', maxPrice: 50, frequency: 'daily' } },
    });
    expect(Object.keys(lastCall().opts.body).sort()).toEqual(['category', 'frequency', 'location', 'maxPrice', 'name', 'searchQuery']);
    expect(JSON.parse(text(created))).toEqual({ id: A, name: 'Kayaks near Austin' });
  });

  it('update_search_alert needs a field and sends only what was passed', async () => {
    const empty = await updateSearchAlert.handler({ alertId: A }, ctx);
    expect(empty.isError).toBe(true);
    expect(mockBackendRequest).not.toHaveBeenCalled();
    await updateSearchAlert.handler({ alertId: A, name: ' Weekly kayaks ', frequency: 'weekly' }, ctx);
    expect(lastCall()).toMatchObject({ method: 'PUT', path: `/search-alerts/${A}`, opts: { token: T, body: { name: 'Weekly kayaks', frequency: 'weekly' } } });
    expect(Object.keys(lastCall().opts.body).sort()).toEqual(['frequency', 'name']);
  });

  it('toggle_search_alert flips via POST toggle or sets a definite state via PUT', async () => {
    mockBackendRequest.mockResolvedValueOnce({ success: true, isActive: false });
    const flipped = await toggleSearchAlert.handler({ alertId: A }, ctx);
    expect(lastCall()).toMatchObject({ method: 'POST', path: `/search-alerts/${A}/toggle`, opts: { token: T } });
    expect(JSON.parse(text(flipped))).toEqual({ alertId: A, isActive: false });
    mockBackendRequest.mockResolvedValueOnce({ success: true, alert: { id: A, name: 'x', isActive: true } });
    const set = await toggleSearchAlert.handler({ alertId: A, isActive: true }, ctx);
    expect(lastCall()).toMatchObject({ method: 'PUT', path: `/search-alerts/${A}`, opts: { token: T, body: { isActive: true } } });
    expect(JSON.parse(text(set))).toEqual({ alertId: A, isActive: true });
  });

  it('delete_search_alert / delete_saved_trip map success and surface backend 404s', async () => {
    expect(JSON.parse(text(await deleteSearchAlert.handler({ alertId: A }, ctx)))).toEqual({ deleted: true, alertId: A });
    expect(lastCall()).toMatchObject({ method: 'DELETE', path: `/search-alerts/${A}`, opts: { token: T } });
    expect(JSON.parse(text(await deleteSavedTrip.handler({ tripId: A }, ctx)))).toEqual({ deleted: true, tripId: A });
    expect(lastCall()).toMatchObject({ method: 'DELETE', path: `/saved-trips/${A}`, opts: { token: T } });
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(404, 'Saved trip not found'));
    const missing = await deleteSavedTrip.handler({ tripId: A }, ctx);
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/^Not found: Saved trip not found/);
  });

  it('list_saved_trips unwraps trips; save_trip needs dates or duration and builds the snapshot', async () => {
    mockBackendRequest.mockResolvedValueOnce({ success: true, trips: [{ id: A }] });
    expect(JSON.parse(text(await listSavedTrips.handler({}, ctx)))).toEqual([{ id: A }]);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/saved-trips', opts: { token: T } });

    const base = { destination: 'Lake Minnetonka, MN', numPeople: 4, activities: ['Boating', 'Biking'] };
    const neither = await saveTrip.handler(base, ctx);
    expect(text(neither)).toMatch(/startDate and endDate, or duration/);
    const oneDate = await saveTrip.handler({ ...base, startDate: '2026-07-17' }, ctx);
    expect(text(oneDate)).toMatch(/both startDate and endDate/);
    const backwards = await saveTrip.handler({ ...base, startDate: '2026-07-19', endDate: '2026-07-17' }, ctx);
    expect(text(backwards)).toMatch(/must not be before/);
    const tooLong = await saveTrip.handler({ ...base, startDate: '2026-07-01', endDate: '2026-08-15' }, ctx);
    expect(text(tooLong)).toMatch(/at most 30 days/);
    const badDate = await saveTrip.handler({ ...base, startDate: 'nope', endDate: '2026-07-19' }, ctx);
    expect(text(badDate)).toMatch(/Invalid startDate/);
    expect(mockBackendRequest.mock.calls.length).toBe(1);

    mockBackendRequest.mockResolvedValueOnce({ success: true, trip: { id: A } });
    const saved = await saveTrip.handler({ ...base, startDate: '2026-07-17', endDate: '2026-07-19', tripSummary: ' A weekend on the water. ', totalEstimatedBudget: '$450 to $600', source: 'board' }, ctx);
    expect(lastCall()).toMatchObject({
      method: 'POST',
      path: '/saved-trips',
      opts: {
        token: T,
        body: { ...base, startDate: '2026-07-17', endDate: '2026-07-19', planSnapshot: { tripSummary: 'A weekend on the water.', totalEstimatedBudget: '$450 to $600', source: 'board' } },
      },
    });
    expect(lastCall().opts.body).not.toHaveProperty('duration');
    expect(JSON.parse(text(saved))).toEqual({ id: A });

    await saveTrip.handler({ ...base, duration: 3 }, ctx);
    expect(lastCall().opts.body).toEqual({ ...base, duration: 3 });
    expect(lastCall().opts.body).not.toHaveProperty('planSnapshot');
  });

  it('email_trip_plan validates the date pair, forwards the whole DTO and reports sent', async () => {
    const one = await emailTripPlan.handler({ destination: 'Moab, UT', numPeople: 2, endDate: '2026-07-19' }, ctx);
    expect(one.isError).toBe(true);
    expect(mockBackendRequest).not.toHaveBeenCalled();
    const res = await emailTripPlan.handler(
      { destination: ' Moab, UT ', numPeople: 2, activities: ['Biking'], duration: 3, tripSummary: 'Desert riding.', poiHighlights: [{ name: 'Slickrock Trail', group: 'Bike trails' }], source: 'board' },
      ctx,
    );
    expect(lastCall()).toMatchObject({
      method: 'POST',
      path: '/trips/email-plan',
      opts: { token: T, body: { destination: 'Moab, UT', numPeople: 2, activities: ['Biking'], duration: 3, tripSummary: 'Desert riding.', poiHighlights: [{ name: 'Slickrock Trail', group: 'Bike trails' }], source: 'board' } },
    });
    expect(Object.keys(lastCall().opts.body).sort()).toEqual(['activities', 'destination', 'duration', 'numPeople', 'poiHighlights', 'source', 'tripSummary']);
    expect(JSON.parse(text(res))).toMatchObject({ sent: true, destination: 'Moab, UT' });
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(429, 'Too many requests'));
    const limited = await emailTripPlan.handler({ destination: 'Moab, UT', numPeople: 2, duration: 1 }, ctx);
    expect(limited.isError).toBe(true);
    expect(text(limited)).toMatch(/rate limiting/);
  });

  it('plan_trip validates strict YYYY-MM-DD dates and the 30-day span before calling the backend', async () => {
    const base = { destination: 'Lake Minnetonka, MN', activities: ['Boating' as const] };
    expect(text(await planTrip.handler({ ...base, start: '2026-07-17T00:00:00Z', end: '2026-07-19' }, anon))).toMatch(/Invalid start/);
    expect(text(await planTrip.handler({ ...base, start: '2026-02-31', end: '2026-03-02' }, anon))).toMatch(/Invalid start/);
    expect(text(await planTrip.handler({ ...base, end: '2026-07-19' }, anon))).toMatch(/both start and end/);
    expect(text(await planTrip.handler({ ...base, start: '2026-07-19', end: '2026-07-17' }, anon))).toMatch(/must not be before/);
    expect(text(await planTrip.handler({ ...base, start: '2026-07-01', end: '2026-07-31' }, anon))).toMatch(/at most 30 days/);
    expect(text(await planTrip.handler({ ...base, start: 'July 4' }, anon))).toMatch(/Invalid start/);
    expect(mockBackendRequest).not.toHaveBeenCalled();

    mockBackendRequest.mockResolvedValueOnce({ available: true, destination: { label: 'Lake Minnetonka, MN', lat: 44.9, lng: -93.6 }, gear: [] });
    const plan = await planTrip.handler({ ...base, activities: ['Boating', 'Biking'], start: '2026-07-17', end: '2026-07-19', people: 4 }, anon);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/trips/plan?destination=Lake+Minnetonka%2C+MN&activities=Boating%2CBiking&start=2026-07-17&end=2026-07-19&people=4' });
    expect(lastCall().opts.token).toBeUndefined();
    expect(JSON.parse(text(plan))).toMatchObject({ available: true, destination: { label: 'Lake Minnetonka, MN' } });

    mockBackendRequest.mockResolvedValueOnce({ available: false, reason: 'geocode-failed' });
    const failed = await planTrip.handler({ ...base, destination: ' Nowhereville ', days: 2 }, anon);
    expect(lastCall().path).toBe('/trips/plan?destination=Nowhereville&activities=Boating&days=2');
    expect(failed.isError).toBeUndefined();
    expect(JSON.parse(text(failed))).toMatchObject({ available: false, reason: 'geocode-failed', hint: expect.stringMatching(/suggest_locations/) });
  });

  it('get_trip_pois, get_trip_ideas_for_listing and suggest_locations are public reads with local guards', async () => {
    await getTripPois.handler({ lat: 44.9298, lng: -93.5841, recipe: 'on-water' }, anon);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/trips/pois?lat=44.9298&lng=-93.5841&recipe=on-water' });
    expect(text(await getTripIdeasForListing.handler({ listingId: L, start: '2026-7-1' }, anon))).toMatch(/Invalid start/);
    expect(text(await getTripIdeasForListing.handler({ listingId: L, start: '2026-07-18', end: 'soon' }, anon))).toMatch(/Invalid end/);
    await getTripIdeasForListing.handler({ listingId: L, start: '2026-07-18', end: '2026-07-19' }, anon);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/trips/ideas/${L}?start=2026-07-18&end=2026-07-19` });
    expect(lastCall().opts.token).toBeUndefined();
    const short = await suggestLocations.handler({ query: ' a ' }, anon);
    expect(short.isError).toBe(true);
    mockBackendRequest.mockResolvedValueOnce({ suggestions: [{ label: 'Lake Minnetonka, MN', lat: 44.9, lng: -93.6 }] });
    const sugg = await suggestLocations.handler({ query: '  lake minnet ' }, anon);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/trips/geocode-suggest?q=lake+minnet' });
    expect(JSON.parse(text(sugg))).toEqual([{ label: 'Lake Minnetonka, MN', lat: 44.9, lng: -93.6 }]);
  });

  it('generate_ai_trip_plan posts the PlanTripDto publicly and passes through an unavailable response', async () => {
    mockBackendRequest.mockResolvedValueOnce({ available: false, reason: 'generation-failed', message: 'Trip planning is temporarily unavailable, please try again.' });
    const res = await generateAiTripPlan.handler({ destination: ' Yosemite National Park, CA ', duration: 3, numPeople: 2, activities: ['hiking', 'camping'], experienceLevel: 'beginner' }, anon);
    expect(lastCall()).toMatchObject({
      method: 'POST',
      path: '/ai/plan-trip',
      opts: { body: { destination: 'Yosemite National Park, CA', duration: 3, numPeople: 2, activities: ['hiking', 'camping'], experienceLevel: 'beginner' } },
    });
    expect(lastCall().opts.token).toBeUndefined();
    expect(JSON.parse(text(res))).toMatchObject({ available: false, reason: 'generation-failed' });
  });

  it('destinations: list unwraps, get requires a slug shape and unwraps', async () => {
    mockBackendRequest.mockResolvedValueOnce({ destinations: [{ slug: 'itasca-state-park' }] });
    expect(JSON.parse(text(await listDestinations.handler({}, anon)))).toEqual([{ slug: 'itasca-state-park' }]);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/destinations' });
    const schema = getDestination.inputSchema.slug;
    expect(schema.safeParse('itasca-state-park').success).toBe(true);
    expect(schema.safeParse('Itasca State Park').success).toBe(false);
    expect(schema.safeParse('../admin').success).toBe(false);
    expect(schema.safeParse('a/b').success).toBe(false);
    mockBackendRequest.mockResolvedValueOnce({ destination: { slug: 'itasca-state-park', routes: [] } });
    expect(JSON.parse(text(await getDestination.handler({ slug: 'itasca-state-park' }, anon)))).toEqual({ slug: 'itasca-state-park', routes: [] });
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/destinations/itasca-state-park' });
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(404, "Destination 'x' not found"));
    const missing = await getDestination.handler({ slug: 'x' }, anon);
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/^Not found:/);
  });

  it('categories: list with or without counts, get merges the category with its stats', async () => {
    mockBackendRequest.mockResolvedValueOnce({ success: true, categories: [{ id: C, name: 'Kayaking' }] });
    expect(JSON.parse(text(await listCategories.handler({}, anon)))).toEqual([{ id: C, name: 'Kayaking' }]);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/categories' });
    await listCategories.handler({ withListingCounts: true }, anon);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/categories/stats' });

    mockBackendRequest.mockImplementation(async (_m: string, path: string) => {
      if (path === `/categories/${C}`) return { success: true, category: { id: C, name: 'Kayaking', slug: 'kayaking' } };
      if (path === `/categories/${C}/stats`) return { success: true, stats: { totalListings: 12 } };
      throw new Error(`unexpected ${path}`);
    });
    const res = await getCategory.handler({ categoryId: C }, anon);
    expect(JSON.parse(text(res))).toEqual({ category: { id: C, name: 'Kayaking', slug: 'kayaking' }, totalListings: 12 });
    expect(mockBackendRequest.mock.calls.map((c) => c[1]).sort()).toEqual([`/categories/${C}`, `/categories/${C}/stats`, '/categories', '/categories/stats'].sort());

    mockBackendRequest.mockImplementation(async (_m: string, path: string) => {
      if (path === `/categories/${C}`) throw new BackendApiError(404, `Category with ID ${C} not found`);
      return { success: true, stats: { totalListings: 0 } };
    });
    const missing = await getCategory.handler({ categoryId: C }, anon);
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/^Not found: Category with ID/);
  });
});
