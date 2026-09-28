/**
 * SPLIT-1608: what an LLM running a vendor account through the MCP ran into on
 * staging (2026-09-28, 243 calls across 114 tools). Each block pins one gap.
 */
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import type { ToolContext } from '../src/tools/registry';

const mockBackendRequest = jest.fn();
jest.mock('../src/lib/backend-client', () => {
  class BackendApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'BackendApiError';
      this.status = status;
    }
  }
  return { BackendApiError, backendRequest: (...args: unknown[]) => mockBackendRequest(...args), backendBaseUrl: () => 'http://backend.test/api/v1' };
});

import { BackendApiError } from '../src/lib/backend-client';
import { LISTING_WRITE_TIMEOUT_MS } from '../src/lib/timeouts';
import { UNCONFIRMED_WRITE } from '../src/tools/_shared';
import { scrubSecrets, ICAL_KEY_REDACTED } from '../src/tools/secrets';
import {
  createListing,
  updateListing,
  duplicateListing,
  setListingPublished,
  listBlackoutDates,
  getVendorDashboard,
  getListingPerformance,
} from '../src/tools/defs/vendor';
import { checkAvailability, getListingCalendar } from '../src/tools/defs/discovery';
import { getVendorOnboardingStatus, improveListingTitle } from '../src/tools/defs/renter';
import { listCategories } from '../src/tools/defs/discovery-extras';
import { setAutoApprove, getReportSubscription, setReportSubscription, getTaxSummary } from '../src/tools/defs/vendor-extras';
import { createRateRule } from '../src/tools/defs/pricing-rules';
import { listMyRoutes } from '../src/tools/defs/routes';

const LISTING = '11111111-1111-4111-8111-111111111111';
const ctx: ToolContext = { userId: 'u', role: 'vendor_owner', token: 'T', kind: 'oauth' };
type Result = { isError?: boolean; content: Array<{ type: string; text?: string }> };
const text = (r: Result) => r.content.map((c) => c.text ?? '').join('');
const data = (r: Result) => JSON.parse(text(r));
const lastCall = () => mockBackendRequest.mock.calls[mockBackendRequest.mock.calls.length - 1];

const kayak = { name: 'Journey kayak', description: 'A stable touring kayak for lakes and calm rivers.', category: 'Kayaking' as const, pricePerDay: 45 };

beforeEach(() => mockBackendRequest.mockReset());

describe('a listing write that times out does not invite a duplicate', () => {
  it('says the change may already have been made, for writes only', async () => {
    mockBackendRequest.mockRejectedValue(new BackendApiError(504, 'Backend request timed out'));
    const created = await createListing.handler(kayak, ctx);
    expect(created.isError).toBe(true);
    expect(text(created)).toBe(UNCONFIRMED_WRITE);
    expect(text(created)).toMatch(/may still have been made/);

    // A read is safe to repeat and keeps the plain message.
    const listed = await listBlackoutDates.handler({ listingId: LISTING }, ctx);
    expect(text(listed)).toBe('Backend request timed out');
  });

  it('gives listing writes the longer budget, and that budget fits the function', () => {
    mockBackendRequest.mockResolvedValue({ id: LISTING });
    return Promise.all([
      createListing.handler(kayak, ctx),
      updateListing.handler({ listingId: LISTING, name: 'Journey kayak v2' }, ctx),
      duplicateListing.handler({ listingId: LISTING }, ctx),
    ]).then(() => {
      for (const [, , options] of mockBackendRequest.mock.calls) expect(options.timeoutMs).toBe(LISTING_WRITE_TIMEOUT_MS);
      const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
      const budgetMs = vercel.functions['src/app/api/mcp/route.ts'].maxDuration * 1000;
      // The 8 s identity probe runs before the tool's own call.
      expect(8_000 + LISTING_WRITE_TIMEOUT_MS).toBeLessThan(budgetMs);
    });
  });
});

describe('location is public and there is no private address field', () => {
  it('neither create nor update offers address or generalArea, and the SDK strips them', () => {
    for (const tool of [createListing, updateListing]) {
      expect(Object.keys(tool.inputSchema)).not.toEqual(expect.arrayContaining(['address']));
      expect(Object.keys(tool.inputSchema)).not.toContain('generalArea');
    }
    const parsed = z.object(createListing.inputSchema).parse({ ...kayak, location: 'Minneapolis, MN', address: '4135 W Lake Harriet Pkwy', generalArea: 'Lake Harriet' });
    expect(parsed).not.toHaveProperty('address');
    expect(parsed).not.toHaveProperty('generalArea');
    expect(createListing.inputSchema.location.description).toMatch(/publicly/);
    expect(createListing.inputSchema.location.description).toMatch(/Never a street address/);
  });
});

describe('stays and the "both" booking type can be created', () => {
  it('offers every backend booking type', () => {
    const bookingType = z.object(createListing.inputSchema).shape.bookingType;
    for (const value of ['daily', 'hourly', 'both', 'nightly']) expect(bookingType.safeParse(value).success).toBe(true);
    expect(bookingType.safeParse('weekly').success).toBe(false);
  });

  it('sends a complete stay, with its check-in and check-out times', async () => {
    mockBackendRequest.mockResolvedValue({ id: LISTING });
    const stay = { name: 'Lakeside cabin', description: 'A quiet two-bedroom cabin with a dock on the lake.', category: 'Cabins' as const, bookingType: 'nightly' as const, pricePerDay: 180, latitude: 46.1, longitude: -94.2, maxGuests: 4, checkInTime: '15:00', checkOutTime: '11:00' };
    const result = await createListing.handler(stay, ctx);
    expect(result.isError).toBeUndefined();
    expect(lastCall()[2].body).toMatchObject({ bookingType: 'nightly', pricePerDay: 180, maxGuests: 4, checkInTime: '15:00', checkOutTime: '11:00' });
    expect(z.object(createListing.inputSchema).shape.checkInTime.safeParse('3pm').success).toBe(false);
  });

  it.each([
    [{ bookingType: 'nightly', category: 'Cabins', pricePerDay: 180, maxGuests: 4 }, 'latitude and longitude'],
    [{ bookingType: 'nightly', category: 'Cabins', pricePerDay: 180, latitude: 46.1, longitude: -94.2 }, 'maxGuests'],
    [{ bookingType: 'nightly', category: 'Cabins', latitude: 46.1, longitude: -94.2, maxGuests: 4 }, 'price per night'],
    [{ bookingType: 'hourly', pricePerDay: 40 }, 'pricePerHour'],
    [{ bookingType: 'both', pricePerDay: 40 }, 'pricePerDay and pricePerHour'],
    [{}, 'Provide pricePerDay'],
  ])('refuses %p before calling Splitt', async (extra, message) => {
    const result = await createListing.handler({ name: kayak.name, description: kayak.description, ...extra } as never, ctx);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(message);
    expect(mockBackendRequest).not.toHaveBeenCalled();
  });

  it('accepts an hourly listing with only an hourly price', async () => {
    mockBackendRequest.mockResolvedValue({ id: LISTING });
    const result = await createListing.handler({ name: kayak.name, description: kayak.description, bookingType: 'hourly', pricePerHour: 15 }, ctx);
    expect(result.isError).toBeUndefined();
  });

  it('rate rules say they are for stays and send gear to dynamic pricing', () => {
    expect(createRateRule.description).toMatch(/daily, hourly or both/);
    expect(createRateRule.description).toContain('set_dynamic_pricing_config');
  });
});

describe('units are counted at creation only', () => {
  it('create takes quantity up to the backend cap of 50; update does not offer it', () => {
    const quantity = z.object(createListing.inputSchema).shape.quantity;
    expect(quantity.safeParse(50).success).toBe(true);
    expect(quantity.safeParse(51).success).toBe(false);
    expect(Object.keys(updateListing.inputSchema)).not.toContain('quantity');
    expect(updateListing.description).toContain('add_fleet_units');
  });
});

describe('publishing a listing that moderation holds is not called live', () => {
  it.each([
    ['pending', /still reviewing/],
    ['flagged', /still reviewing/],
    ['rejected', /rejected it/],
  ])('adds a note while moderationStatus is %s', async (moderationStatus, note) => {
    mockBackendRequest.mockResolvedValue({ id: LISTING, status: 'available', moderationStatus });
    expect(data(await setListingPublished.handler({ listingId: LISTING, published: true }, ctx)).note).toMatch(note);
  });

  it('adds nothing once approved, or when unpublishing', async () => {
    mockBackendRequest.mockResolvedValue({ id: LISTING, status: 'available', moderationStatus: 'approved' });
    expect(data(await setListingPublished.handler({ listingId: LISTING, published: true }, ctx))).not.toHaveProperty('note');
    mockBackendRequest.mockResolvedValue({ id: LISTING, status: 'draft', moderationStatus: 'pending' });
    expect(data(await setListingPublished.handler({ listingId: LISTING, published: false }, ctx))).not.toHaveProperty('note');
    expect(setListingPublished.description).toMatch(/at least 3 photos/);
  });
});

describe('list_blackout_dates reaches every block', () => {
  const synced = (day: string, n: number) => ({ id: `s${n}`, startDate: day, endDate: day, type: 'sync', sourceFeedId: 'f1' });
  const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  // 152 synced holidays (stored half-open) plus one manual 2-day block, unsorted.
  const days = Array.from({ length: 152 }, (_, i) => new Date(Date.UTC(2026, 9, 1 + i * 10)).toISOString().slice(0, 10));
  const rows = [
    { id: 'm1', startDate: '2027-03-01', endDate: '2027-03-03', type: 'unavailable', sourceFeedId: null },
    ...days.map((day, i) => ({ ...synced(day, i), endDate: nextDay(day) })).reverse(),
  ];

  it('pages with a total, sorted by first day', async () => {
    mockBackendRequest.mockResolvedValue(rows);
    const first = data(await listBlackoutDates.handler({ listingId: LISTING }, ctx));
    expect(first.total).toBe(153);
    expect(first.items).toHaveLength(50);
    expect(first.items[0].startDate).toBe(days[0]);
    const last = data(await listBlackoutDates.handler({ listingId: LISTING, offset: 150, limit: 50 }, ctx));
    expect(last.items).toHaveLength(3);
    expect(last.items[2].startDate).toBe(days[151]);
  });

  it('filters by overlapping days and by source, with inclusive days', async () => {
    mockBackendRequest.mockResolvedValue(rows);
    const march = data(await listBlackoutDates.handler({ listingId: LISTING, from: '2027-03-02', to: '2027-03-02', source: 'manual' }, ctx));
    expect(march).toEqual({ total: 1, offset: 0, items: [expect.objectContaining({ id: 'm1', startDate: '2027-03-01', endDate: '2027-03-02' })] });
    const syncedOnly = data(await listBlackoutDates.handler({ listingId: LISTING, source: 'synced', limit: 100 }, ctx));
    expect(syncedOnly.total).toBe(152);
    expect(syncedOnly.items.every((row: { type: string }) => row.type === 'sync')).toBe(true);
  });

  it('never hides a row whose days cannot be read, and refuses a bad filter date', async () => {
    mockBackendRequest.mockResolvedValue([{ id: 'odd', startDate: null, endDate: null }]);
    expect(data(await listBlackoutDates.handler({ listingId: LISTING, from: '2030-01-01' }, ctx)).total).toBe(1);
    const bad = await listBlackoutDates.handler({ listingId: LISTING, from: 'soon' }, ctx);
    expect(bad.isError).toBe(true);
  });
});

describe('AI helpers never pass off the input as a suggestion', () => {
  it('improve_listing_title: the same title back is "no suggestion"', async () => {
    mockBackendRequest.mockResolvedValue({ title: '  journey test KAYAK  ' });
    const same = await improveListingTitle.handler({ currentTitle: 'Journey test kayak' }, ctx);
    expect(same.isError).toBe(true);
    expect(text(same)).toMatch(/suggested no change/);
    mockBackendRequest.mockResolvedValue({ title: 'Stable touring kayak for lakes' });
    expect(text(await improveListingTitle.handler({ currentTitle: 'Journey test kayak' }, ctx))).toBe('Stable touring kayak for lakes');
  });
});

describe('list_categories returns one shape with or without counts', () => {
  it('maps the stats rows to the plain category shape with a numeric count', async () => {
    mockBackendRequest.mockResolvedValue([{ category_id: 'c1', category_name: 'E-Bikes', category_slug: 'e-bikes', category_sortOrder: 2, listingCount: '7' }]);
    expect(data(await listCategories.handler({ withListingCounts: true }, ctx))).toEqual([{ id: 'c1', name: 'E-Bikes', slug: 'e-bikes', sortOrder: 2, listingCount: 7 }]);
    expect(mockBackendRequest.mock.calls[0][1]).toBe('/categories/stats');
    mockBackendRequest.mockResolvedValue([{ id: 'c1', name: 'E-Bikes', slug: 'e-bikes' }]);
    expect(data(await listCategories.handler({}, ctx))).toEqual([{ id: 'c1', name: 'E-Bikes', slug: 'e-bikes' }]);
  });
});

describe('get_vendor_onboarding_status names the next step from the steps themselves', () => {
  const steps = [
    { key: 'profile', label: 'Business profile', complete: true },
    { key: 'stripe', label: 'Connect payouts (Stripe)', complete: true },
    { key: 'waiver', label: 'Sign liability waiver', complete: false },
  ];

  it('does not send an existing vendor back to Stripe when the stored status lags', async () => {
    mockBackendRequest.mockResolvedValue({ role: 'vendor_owner', status: 'stripe_pending', steps });
    const next = data(await getVendorOnboardingStatus.handler({}, ctx)).nextStep;
    expect(next).toMatch(/already has the vendor role \(vendor_owner\)/);
    expect(next).toContain('sign_vendor_agreement');
    expect(next).not.toContain('start_vendor_stripe_onboarding');
  });

  it('follows the first open step for an applicant, and the status when there are no steps', async () => {
    mockBackendRequest.mockResolvedValue({ role: 'renter', status: 'stripe_pending', steps });
    expect(data(await getVendorOnboardingStatus.handler({}, ctx)).nextStep).toContain('get_vendor_agreement');
    mockBackendRequest.mockResolvedValue({ role: 'renter', status: 'admin_review' });
    expect(data(await getVendorOnboardingStatus.handler({}, ctx)).nextStep).toMatch(/Splitt is reviewing/);
    mockBackendRequest.mockResolvedValue({ role: 'vendor_owner', status: 'active', steps: steps.map((s) => ({ ...s, complete: true })) });
    expect(data(await getVendorOnboardingStatus.handler({}, ctx)).nextStep).toMatch(/no onboarding step is open/);
  });
});

describe('what never reaches the model', () => {
  it('redacts the listing calendar key and drops embeddings and internal user fields, at any depth', () => {
    const host = { id: 'v1', firstName: 'Alex', termsAcceptedIp: '203.0.113.9', termsAcceptedUserAgent: 'Mozilla/5.0', customCommissionRate: '0.08', moderationBypassEnabled: true, suspensionReason: 'note', trustScore: 88 };
    const scrubbed = scrubSecrets({ id: LISTING, icalFeedToken: 'k'.repeat(64), embedding: [0.1, 0.2], service: { host } });
    expect(scrubbed).toEqual({ id: LISTING, icalFeedToken: ICAL_KEY_REDACTED, service: { host: { id: 'v1', firstName: 'Alex', trustScore: 88 } } });
    expect(scrubSecrets({ id: LISTING, icalFeedToken: null })).toEqual({ id: LISTING });
  });
});

describe('seat notes say who may actually change each setting', () => {
  it('auto-approve needs a pricing seat, report emails are per seat, the tax summary is a read', () => {
    expect(setAutoApprove.description).toMatch(/vendor_staff seats cannot/);
    for (const tool of [getReportSubscription, setReportSubscription]) expect(tool.description).toMatch(/Each seat .* has its own report email settings/);
    expect(getTaxSummary.description).not.toMatch(/seat/);
  });
});

describe('reporting ranges are checked before they reach Splitt', () => {
  it.each([getVendorDashboard, getListingPerformance])('%# refuses an unreadable or reversed range', async (tool) => {
    expect(text(await tool.handler({ startDate: 'not-a-date' }, ctx))).toMatch(/ISO dates/);
    expect(text(await tool.handler({ startDate: '2026-09-07', endDate: '2026-09-01' }, ctx))).toMatch(/on or after/);
    expect(mockBackendRequest).not.toHaveBeenCalled();
  });
});

describe('date errors and windows speak the tool\'s own terms', () => {
  it('check_availability names checkIn and checkOut, and says the return day is not rented', async () => {
    const same = await checkAvailability.handler({ listingId: LISTING, checkIn: '2027-03-03', checkOut: '2027-03-03', guests: 1 }, ctx);
    expect(text(same)).toBe('checkOut must be after checkIn.');
    expect(checkAvailability.description).toMatch(/return day and is not part of the rental/);
  });

  it('get_listing_calendar serves a one-day window by asking for the next day too, and returns only that day', async () => {
    mockBackendRequest.mockResolvedValue([
      { startDate: '2027-03-03T00:00:00.000Z', isAvailable: true },
      { startDate: '2027-03-04T00:00:00.000Z', isAvailable: false },
    ]);
    const one = await getListingCalendar.handler({ listingId: LISTING, from: '2027-03-03', to: '2027-03-03' }, ctx);
    expect(lastCall()[1]).toBe(`/rentals/${LISTING}/availability/calendar?from=2027-03-03&to=2027-03-04`);
    expect(data(one)).toEqual([{ startDate: '2027-03-03T00:00:00.000Z', isAvailable: true }]);
    expect(text(await getListingCalendar.handler({ listingId: LISTING, from: '2027-03-04', to: '2027-03-03' }, ctx))).toBe('to must be on or after from.');
  });
});

describe('the route library list leaves the tracks out', () => {
  it('drops geometry, polyline and elevation profile from each row', async () => {
    mockBackendRequest.mockResolvedValue({ routes: [{ id: 'r1', name: 'Lake loop', distanceM: 5200, geometry: { type: 'LineString' }, encodedPolyline: 'abc', elevationProfile: [1, 2] }] });
    expect(data(await listMyRoutes.handler({}, ctx))).toEqual({ routes: [{ id: 'r1', name: 'Lake loop', distanceM: 5200 }] });
  });
});
