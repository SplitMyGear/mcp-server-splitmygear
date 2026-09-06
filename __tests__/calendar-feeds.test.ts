/** Contract tests for the calendar-feeds backend module + tool defs: exact method/path/body/token per call, handler guards. */
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
    backendBaseUrl: () => 'https://api.example.test/api/v1/',
  };
});

import { calendarFeedApi, normalizeCalendarUrl, isHttpUrl, listingIcalExportUrl } from '../src/tools/calendar-feeds';
import {
  calendarFeedTools,
  listCalendarFeeds,
  addCalendarFeed,
  syncCalendarFeed,
  updateCalendarFeed,
  removeCalendarFeed,
  clearFeedSuppression,
  getListingIcalExportUrl,
  getCalendarSubscriptionUrl,
  rotateCalendarSubscriptionUrl,
} from '../src/tools/defs/calendar-feeds';
import { TOOL_SCOPES, type ToolContext } from '../src/tools/registry';
import { z } from 'zod';

const T = 'h.p.s';
const L = '11111111-1111-4111-8111-111111111111';
const F = '22222222-2222-4222-8222-222222222222';
const S = '33333333-3333-4333-8333-333333333333';
const ctx: ToolContext = { userId: 'u', role: 'vendor', token: T, kind: 'oauth' };
const { BackendApiError } = jest.requireMock('../src/lib/backend-client');

const SUB = { token: 'secret-token', url: 'https://api.example.test/api/v1/vendor/calendar/secret-token', webcalUrl: 'webcal://api.example.test/api/v1/vendor/calendar/secret-token', issuedAt: '2026-09-01T00:00:00.000Z' };

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

describe('calendar-feeds helpers', () => {
  it('normalizes webcal:// to https:// and trims', () => {
    expect(normalizeCalendarUrl('  webcal://cal.example.com/x.ics ')).toBe('https://cal.example.com/x.ics');
    expect(normalizeCalendarUrl('WEBCAL://cal.example.com/x.ics')).toBe('https://cal.example.com/x.ics');
    expect(normalizeCalendarUrl('https://www.airbnb.com/calendar/ical/1.ics?s=abc')).toBe('https://www.airbnb.com/calendar/ical/1.ics?s=abc');
    expect(normalizeCalendarUrl('http://cal.example.com/x.ics')).toBe('http://cal.example.com/x.ics');
  });

  it('accepts only absolute http(s) URLs with a host', () => {
    expect(isHttpUrl('https://cal.example.com/x.ics')).toBe(true);
    expect(isHttpUrl('http://cal.example.com/x.ics')).toBe(true);
    expect(isHttpUrl('webcal://cal.example.com/x.ics')).toBe(false);
    expect(isHttpUrl('ftp://cal.example.com/x.ics')).toBe(false);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('cal.example.com/x.ics')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
  });

  it('builds the public listing export URL from the backend base without a double slash', () => {
    expect(listingIcalExportUrl(L)).toBe(`https://api.example.test/api/v1/bookings/ical/${L}`);
  });
});

describe('calendarFeedApi (backend module)', () => {
  it('lists feeds for a listing with the token and no body', async () => {
    await calendarFeedApi.list(T, L);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/rentals/${L}/calendar-feeds`, opts: { token: T } });
    expect(lastCall().opts.body).toBeUndefined();
  });

  it('connects a feed sending only CreateCalendarFeedDto fields', async () => {
    await calendarFeedApi.add(T, L, { url: 'https://cal.example.com/x.ics', label: 'Airbnb', unitsPerHold: undefined });
    expect(lastCall()).toMatchObject({ method: 'POST', path: `/rentals/${L}/calendar-feeds`, opts: { token: T, body: { url: 'https://cal.example.com/x.ics', label: 'Airbnb' } } });
    expect(lastCall().opts.body).not.toHaveProperty('unitsPerHold');
    await calendarFeedApi.add(T, L, { url: 'https://cal.example.com/y.ics', unitsPerHold: 2 });
    expect(lastCall().opts.body).toEqual({ url: 'https://cal.example.com/y.ics', unitsPerHold: 2 });
  });

  it('syncs, updates, removes feeds and clears suppressions', async () => {
    await calendarFeedApi.sync(T, F);
    expect(lastCall()).toMatchObject({ method: 'POST', path: `/calendar-feeds/${F}/sync`, opts: { token: T, body: {} } });
    await calendarFeedApi.update(T, F, { isEnabled: true, label: undefined, unitsPerHold: null });
    expect(lastCall()).toMatchObject({ method: 'PATCH', path: `/calendar-feeds/${F}`, opts: { token: T, body: { isEnabled: true, unitsPerHold: null } } });
    expect(lastCall().opts.body).not.toHaveProperty('label');
    expect(Object.keys(lastCall().opts.body).sort()).toEqual(['isEnabled', 'unitsPerHold']);
    await calendarFeedApi.remove(T, F);
    expect(lastCall()).toMatchObject({ method: 'DELETE', path: `/calendar-feeds/${F}`, opts: { token: T } });
    expect(lastCall().opts.body).toBeUndefined();
    await calendarFeedApi.removeSuppression(T, S);
    expect(lastCall()).toMatchObject({ method: 'DELETE', path: `/calendar-feeds/suppressions/${S}`, opts: { token: T } });
    expect(lastCall().opts.body).toBeUndefined();
  });

  it('reads and rotates the account subscription link', async () => {
    await calendarFeedApi.getSubscription(T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/vendor/calendar/subscription', opts: { token: T } });
    expect(lastCall().opts.body).toBeUndefined();
    await calendarFeedApi.rotateSubscription(T);
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/vendor/calendar/subscription/rotate', opts: { token: T, body: {} } });
  });

  it('returns an error Result (never throws) when the backend rejects', async () => {
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(400, 'This listing already has the maximum of 5 connected calendar feeds'));
    expect(await calendarFeedApi.add(T, L, { url: 'https://cal.example.com/x.ics' })).toEqual({ ok: false, error: 'This listing already has the maximum of 5 connected calendar feeds', status: 400 });
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(404, 'Calendar feed with ID x not found'));
    expect(await calendarFeedApi.sync(T, F)).toMatchObject({ ok: false, status: 404 });
    mockBackendRequest.mockRejectedValueOnce(new Error('net'));
    expect((await calendarFeedApi.getSubscription(T)).ok).toBe(false);
  });
});

describe('calendar feed tool defs', () => {
  it('exports the tool set with docs, access, scope and annotations on every def', () => {
    expect(calendarFeedTools.map((t) => t.name)).toEqual([
      'list_calendar_feeds',
      'add_calendar_feed',
      'sync_calendar_feed',
      'update_calendar_feed',
      'remove_calendar_feed',
      'clear_feed_suppression',
      'get_listing_ical_export_url',
      'get_calendar_subscription_url',
      'rotate_calendar_subscription_url',
    ]);
    for (const t of calendarFeedTools) {
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect(t.access).toBe('vendor');
      expect(t.scope).toBe('listings');
      expect(TOOL_SCOPES).toContain(t.scope);
      expect(t.title.length).toBeGreaterThan(2);
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.description).not.toMatch(/\u2014/);
      expect(t.annotations).toHaveProperty('readOnlyHint');
      expect(typeof t.handler).toBe('function');
    }
    expect(calendarFeedTools.filter((t) => t.annotations.destructiveHint).map((t) => t.name)).toEqual(['remove_calendar_feed', 'rotate_calendar_subscription_url']);
    expect(calendarFeedTools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name)).toEqual(['list_calendar_feeds', 'get_listing_ical_export_url']);
    expect(addCalendarFeed.annotations.idempotentHint).toBe(false);
    expect(getCalendarSubscriptionUrl.description).toMatch(/secret/i);
    expect(rotateCalendarSubscriptionUrl.description).toMatch(/old link stops working/i);
  });

  it('input schemas enforce UUID path params, URL length, label length and unitsPerHold range', () => {
    const a = z.object(addCalendarFeed.inputSchema);
    expect(a.safeParse({ listingId: L, url: 'https://cal.example.com/x.ics' }).success).toBe(true);
    expect(a.safeParse({ listingId: L, url: 'https://cal.example.com/x.ics', label: 'Airbnb', unitsPerHold: 3 }).success).toBe(true);
    expect(a.safeParse({ listingId: 'not-a-uuid', url: 'https://cal.example.com/x.ics' }).success).toBe(false);
    expect(a.safeParse({ listingId: L, url: 'x' }).success).toBe(false);
    expect(a.safeParse({ listingId: L, url: `https://cal.example.com/${'a'.repeat(2048)}` }).success).toBe(false);
    expect(a.safeParse({ listingId: L, url: 'https://cal.example.com/x.ics', label: 'l'.repeat(81) }).success).toBe(false);
    expect(a.safeParse({ listingId: L, url: 'https://cal.example.com/x.ics', unitsPerHold: 0 }).success).toBe(false);
    expect(a.safeParse({ listingId: L, url: 'https://cal.example.com/x.ics', unitsPerHold: 1001 }).success).toBe(false);
    expect(a.safeParse({ listingId: L, url: 'https://cal.example.com/x.ics', unitsPerHold: 1.5 }).success).toBe(false);

    const u = z.object(updateCalendarFeed.inputSchema);
    expect(u.safeParse({ feedId: F, isEnabled: false }).success).toBe(true);
    expect(u.safeParse({ feedId: F, unitsPerHold: null }).success).toBe(true);
    expect(u.safeParse({ feedId: F, unitsPerHold: 1000 }).success).toBe(true);
    expect(u.safeParse({ feedId: F, unitsPerHold: 0 }).success).toBe(false);
    expect(u.safeParse({ feedId: 'nope', isEnabled: true }).success).toBe(false);

    expect(z.object(listCalendarFeeds.inputSchema).safeParse({ listingId: 'x' }).success).toBe(false);
    expect(z.object(syncCalendarFeed.inputSchema).safeParse({ feedId: 'x' }).success).toBe(false);
    expect(z.object(removeCalendarFeed.inputSchema).safeParse({ feedId: F }).success).toBe(true);
    expect(z.object(clearFeedSuppression.inputSchema).safeParse({ suppressionId: 'x' }).success).toBe(false);
    expect(z.object(getListingIcalExportUrl.inputSchema).safeParse({ listingId: 'x' }).success).toBe(false);
    expect(z.object(getCalendarSubscriptionUrl.inputSchema).safeParse({}).success).toBe(true);
    expect(z.object(rotateCalendarSubscriptionUrl.inputSchema).safeParse({}).success).toBe(true);
  });

  it('list_calendar_feeds forwards the token and wraps the array with a count', async () => {
    mockBackendRequest.mockResolvedValueOnce([{ id: F, label: 'Airbnb', suppressions: [] }]);
    const res = await listCalendarFeeds.handler({ listingId: L }, ctx);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/rentals/${L}/calendar-feeds`, opts: { token: T } });
    expect(JSON.parse(text(res))).toEqual({ count: 1, feeds: [{ id: F, label: 'Airbnb', suppressions: [] }] });
  });

  it('add_calendar_feed normalizes webcal, trims the label, refuses non-http URLs before calling the backend', async () => {
    await addCalendarFeed.handler({ listingId: L, url: ' webcal://cal.example.com/x.ics ', label: '  Airbnb  ', unitsPerHold: 2 }, ctx);
    expect(lastCall()).toMatchObject({ method: 'POST', path: `/rentals/${L}/calendar-feeds`, opts: { token: T, body: { url: 'https://cal.example.com/x.ics', label: 'Airbnb', unitsPerHold: 2 } } });
    await addCalendarFeed.handler({ listingId: L, url: 'https://cal.example.com/y.ics', label: '   ' }, ctx);
    expect(lastCall().opts.body).toEqual({ url: 'https://cal.example.com/y.ics' });

    const calls = mockBackendRequest.mock.calls.length;
    for (const url of ['ftp://cal.example.com/x.ics', 'javascript:alert(1)', 'cal.example.com/x.ics', 'file:///etc/passwd']) {
      const refused = await addCalendarFeed.handler({ listingId: L, url }, ctx);
      expect(refused.isError).toBe(true);
      expect(text(refused)).toMatch(/http/);
    }
    expect(mockBackendRequest.mock.calls.length).toBe(calls);
  });

  it('add_calendar_feed surfaces the backend cap / self-feed refusal', async () => {
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(400, 'You already have the maximum of 25 connected calendar feeds across your listings'));
    const res = await addCalendarFeed.handler({ listingId: L, url: 'https://cal.example.com/x.ics' }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/maximum of 25/);
  });

  it('sync_calendar_feed posts to the sync route and returns the counts', async () => {
    mockBackendRequest.mockResolvedValueOnce({ feed: { id: F }, importedCount: 3, removedCount: 1 });
    const res = await syncCalendarFeed.handler({ feedId: F }, ctx);
    expect(lastCall()).toMatchObject({ method: 'POST', path: `/calendar-feeds/${F}/sync`, opts: { token: T } });
    expect(JSON.parse(text(res))).toEqual({ feed: { id: F }, importedCount: 3, removedCount: 1 });
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(429, 'Too many requests'));
    const limited = await syncCalendarFeed.handler({ feedId: F }, ctx);
    expect(limited.isError).toBe(true);
    expect(text(limited)).toMatch(/rate limiting/);
  });

  it('update_calendar_feed requires a field, refuses a blank label, keeps null unitsPerHold and forwards the patch', async () => {
    const empty = await updateCalendarFeed.handler({ feedId: F }, ctx);
    expect(empty.isError).toBe(true);
    const blank = await updateCalendarFeed.handler({ feedId: F, label: '   ' }, ctx);
    expect(blank.isError).toBe(true);
    expect(mockBackendRequest).not.toHaveBeenCalled();

    await updateCalendarFeed.handler({ feedId: F, isEnabled: true }, ctx);
    expect(lastCall()).toMatchObject({ method: 'PATCH', path: `/calendar-feeds/${F}`, opts: { token: T, body: { isEnabled: true } } });
    expect(Object.keys(lastCall().opts.body)).toEqual(['isEnabled']);

    await updateCalendarFeed.handler({ feedId: F, label: ' VRBO ', unitsPerHold: null }, ctx);
    expect(lastCall().opts.body).toEqual({ label: 'VRBO', unitsPerHold: null });
  });

  it('remove_calendar_feed and clear_feed_suppression map the 204 to a confirmation and surface 404s', async () => {
    mockBackendRequest.mockResolvedValueOnce(undefined);
    const removed = await removeCalendarFeed.handler({ feedId: F }, ctx);
    expect(lastCall()).toMatchObject({ method: 'DELETE', path: `/calendar-feeds/${F}`, opts: { token: T } });
    expect(JSON.parse(text(removed))).toEqual({ removed: true, feedId: F });

    mockBackendRequest.mockResolvedValueOnce(undefined);
    const cleared = await clearFeedSuppression.handler({ suppressionId: S }, ctx);
    expect(lastCall()).toMatchObject({ method: 'DELETE', path: `/calendar-feeds/suppressions/${S}`, opts: { token: T } });
    expect(JSON.parse(text(cleared))).toMatchObject({ cleared: true, suppressionId: S });

    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(404, `Calendar feed with ID ${F} not found`));
    const missing = await removeCalendarFeed.handler({ feedId: F }, ctx);
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/^Not found: Calendar feed/);
  });

  it('get_listing_ical_export_url builds the public link locally without calling the backend', async () => {
    const res = await getListingIcalExportUrl.handler({ listingId: L }, ctx);
    expect(mockBackendRequest).not.toHaveBeenCalled();
    expect(JSON.parse(text(res))).toEqual({ listingId: L, url: `https://api.example.test/api/v1/bookings/ical/${L}`, format: 'text/calendar' });
  });

  it('get_calendar_subscription_url returns url/webcalUrl with a warning and never the bare token field', async () => {
    mockBackendRequest.mockResolvedValueOnce(SUB);
    const res = await getCalendarSubscriptionUrl.handler({}, ctx);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/vendor/calendar/subscription', opts: { token: T } });
    const body = JSON.parse(text(res));
    expect(body).toMatchObject({ url: SUB.url, webcalUrl: SUB.webcalUrl, issuedAt: SUB.issuedAt });
    expect(body.warning).toMatch(/secret/i);
    expect(body).not.toHaveProperty('token');
    expect(res.isError).toBeUndefined();
  });

  it('rotate_calendar_subscription_url posts to rotate and returns the new link flagged as rotated', async () => {
    mockBackendRequest.mockResolvedValueOnce({ ...SUB, token: 'new', url: 'https://api.example.test/api/v1/vendor/calendar/new', webcalUrl: 'webcal://api.example.test/api/v1/vendor/calendar/new' });
    const res = await rotateCalendarSubscriptionUrl.handler({}, ctx);
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/vendor/calendar/subscription/rotate', opts: { token: T, body: {} } });
    const body = JSON.parse(text(res));
    expect(body).toMatchObject({ rotated: true, url: 'https://api.example.test/api/v1/vendor/calendar/new' });
    expect(body).not.toHaveProperty('token');
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(403, 'Forbidden resource'));
    const denied = await rotateCalendarSubscriptionUrl.handler({}, ctx);
    expect(denied.isError).toBe(true);
    expect(text(denied)).toMatch(/^Not allowed for this account/);
  });
});
