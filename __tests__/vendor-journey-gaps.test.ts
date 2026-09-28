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
  deleteListing,
  listBlackoutDates,
  removeBlackoutDate,
  getVendorDashboard,
  getListingPerformance,
  createExperience,
  updateExperience,
  vendorTools,
} from '../src/tools/defs/vendor';
import * as vendorDefs from '../src/tools/defs/vendor';
import { checkAvailability, getListingCalendar, getExperienceDetails, getBookingQuote } from '../src/tools/defs/discovery';
import { getVendorOnboardingStatus, improveListingTitle } from '../src/tools/defs/renter';
import { listCategories } from '../src/tools/defs/discovery-extras';
import { setAutoApprove, getReportSubscription, setReportSubscription, getTaxSummary, listMyTransactions, getTransaction } from '../src/tools/defs/vendor-extras';
import { createRateRule, setDynamicPricingConfig } from '../src/tools/defs/pricing-rules';
import { listMyRoutes } from '../src/tools/defs/routes';
import { listFleetUnits, getUnitStats, getUnitMaintenanceHistory, addFleetUnits, updateFleetUnit, logUnitMaintenance } from '../src/tools/defs/fleet';
import { addCalendarFeed, updateCalendarFeed, syncCalendarFeed } from '../src/tools/defs/calendar-feeds';
import { deleteService, updateService } from '../src/tools/defs/services';

const LISTING = '11111111-1111-4111-8111-111111111111';
const EXPERIENCE = '33333333-3333-4333-8333-333333333333';
const ctx: ToolContext = { userId: 'u', role: 'vendor_owner', token: 'T', kind: 'oauth' };
type Result = { isError?: boolean; content: Array<{ type: string; text?: string }> };
const text = (r: Result) => r.content.map((c) => c.text ?? '').join('');
const data = (r: Result) => JSON.parse(text(r));
const lastCall = () => mockBackendRequest.mock.calls[mockBackendRequest.mock.calls.length - 1];

/**
 * archive_listing and delete_experience are new tools added by the batch-2
 * commit under test below (bdbe977). A named import of either fails to compile
 * against the pre-batch tree (cbbcb26) and would take every other test in this
 * file down with it, so they are read off the namespace import at a generic
 * shape instead, keeping the rest of the file's tests independently runnable
 * against both trees (SPLIT-1608).
 */
interface NewVendorTool {
  description: string;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<Result>;
}
const archiveListing = (vendorDefs as unknown as Record<string, NewVendorTool>).archiveListing;
const deleteExperience = (vendorDefs as unknown as Record<string, NewVendorTool>).deleteExperience;

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

describe('instantBook is an update_listing-only setting', () => {
  it('create_listing does not offer instantBook; update_listing does, describing the PENDING/auto-confirm behavior', () => {
    expect(Object.keys(createListing.inputSchema)).not.toContain('instantBook');
    expect(Object.keys(updateListing.inputSchema)).toContain('instantBook');
    expect(updateListing.inputSchema.instantBook.description).toMatch(/confirmed automatically/);
    expect(updateListing.inputSchema.instantBook.description).toMatch(/lands as PENDING/);
    expect(updateListing.inputSchema.instantBook.description).toContain('set_auto_approve');
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
    // This fixture mirrors the live GET /categories/stats response: an envelope
    // ({ success, categories }), not a bare array (SPLIT-1608).
    mockBackendRequest.mockResolvedValue({ success: true, categories: [{ category_id: 'c1', category_name: 'E-Bikes', category_slug: 'e-bikes', category_sortOrder: 2, listingCount: '7' }] });
    expect(data(await listCategories.handler({ withListingCounts: true }, ctx))).toEqual([{ id: 'c1', name: 'E-Bikes', slug: 'e-bikes', sortOrder: 2, listingCount: 7 }]);
    expect(mockBackendRequest.mock.calls[0][1]).toBe('/categories/stats');
    // GET /categories (no counts) is the same { success, categories } envelope.
    mockBackendRequest.mockResolvedValue({ success: true, categories: [{ id: 'c1', name: 'E-Bikes', slug: 'e-bikes' }] });
    expect(data(await listCategories.handler({}, ctx))).toEqual([{ id: 'c1', name: 'E-Bikes', slug: 'e-bikes' }]);
  });

  it('still maps a bare array of stats rows, if the backend ever answers that way', async () => {
    mockBackendRequest.mockResolvedValue([{ category_id: 'c1', category_name: 'E-Bikes', category_slug: 'e-bikes', listingCount: '7' }]);
    expect(data(await listCategories.handler({ withListingCounts: true }, ctx))).toEqual([{ id: 'c1', name: 'E-Bikes', slug: 'e-bikes', listingCount: 7 }]);
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

// ── SPLIT-1608 batch 2 (bdbe977) ─────────────────────────────────────────────

describe('fleet tools trim an embedded listing to id and name', () => {
  const UNIT = '22222222-2222-4222-8222-222222222222';
  const bigListing = { id: 'L1', name: 'Journey kayak', description: 'A'.repeat(400), careGuide: 'Rinse after every use.' };
  const trimmedListing = { id: 'L1', name: 'Journey kayak' };

  it('list_fleet_units, get_unit_stats and get_unit_maintenance_history trim it, however deep it is nested', async () => {
    mockBackendRequest.mockResolvedValue([{ id: UNIT, label: 'Unit 1', listing: bigListing }]);
    expect(data(await listFleetUnits.handler({}, ctx))).toEqual([{ id: UNIT, label: 'Unit 1', listing: trimmedListing }]);

    mockBackendRequest.mockResolvedValue({ id: UNIT, listing: bigListing, completedBookings: 5 });
    expect(data(await getUnitStats.handler({ unitId: UNIT }, ctx))).toEqual({ id: UNIT, listing: trimmedListing, completedBookings: 5 });

    mockBackendRequest.mockResolvedValue([{ id: 'm1', kind: 'service', unit: { id: UNIT, listing: bigListing } }]);
    expect(data(await getUnitMaintenanceHistory.handler({ unitId: UNIT }, ctx))).toEqual([{ id: 'm1', kind: 'service', unit: { id: UNIT, listing: trimmedListing } }]);
  });

  it('add_fleet_units trims it for a single unit and for a bulk batch, and still caps bulk at 50 per call', async () => {
    mockBackendRequest.mockResolvedValue({ id: UNIT, listing: bigListing });
    expect(data(await addFleetUnits.handler({ listingId: LISTING, label: 'Unit' }, ctx))).toEqual({ id: UNIT, listing: trimmedListing });

    mockBackendRequest.mockResolvedValue([{ id: UNIT, listing: bigListing }, { id: 'u2', listing: bigListing }]);
    expect(data(await addFleetUnits.handler({ listingId: LISTING, count: 2 }, ctx))).toEqual({
      created: 2,
      units: [{ id: UNIT, listing: trimmedListing }, { id: 'u2', listing: trimmedListing }],
    });
    expect(addFleetUnits.description).toContain('capped at 50 units per call');
  });

  it('update_fleet_unit and log_unit_maintenance trim it too', async () => {
    mockBackendRequest.mockResolvedValue({ id: UNIT, status: 'available', listing: bigListing });
    expect(data(await updateFleetUnit.handler({ unitId: UNIT, status: 'available' }, ctx))).toEqual({ id: UNIT, status: 'available', listing: trimmedListing });

    mockBackendRequest.mockResolvedValue({ unit: { id: UNIT, listing: bigListing }, record: { id: 'm1' } });
    expect(data(await logUnitMaintenance.handler({ unitId: UNIT, kind: 'service', description: 'Oil change' }, ctx))).toEqual({
      unit: { id: UNIT, listing: trimmedListing },
      record: { id: 'm1' },
    });
  });
});

describe('archive_listing retires a listing through the bulk status endpoint', () => {
  it('sends listingIds/status and the token, and returns { archived, listingId }', async () => {
    mockBackendRequest.mockResolvedValue([{ id: LISTING, status: 'archived' }]);
    const result = await archiveListing.handler({ listingId: LISTING }, ctx);
    const [method, path, opts] = mockBackendRequest.mock.calls[0];
    expect([method, path]).toEqual(['POST', '/rentals/bulk/status']);
    expect(opts).toMatchObject({ token: ctx.token, body: { listingIds: [LISTING], status: 'archived' } });
    expect(result.isError).toBeUndefined();
    expect(data(result)).toEqual({ archived: true, listingId: LISTING });
  });

  it('is a registered vendor tool, and delete_listing points to it', () => {
    expect(vendorTools.some((t) => t.name === 'archive_listing')).toBe(true);
    expect(deleteListing.description).toContain('archive_listing');
  });
});

describe('set_listing_published uses the listing-write timeout', () => {
  it('passes LISTING_WRITE_TIMEOUT_MS to the backend call', async () => {
    mockBackendRequest.mockResolvedValue({ id: LISTING, status: 'available', moderationStatus: 'approved' });
    await setListingPublished.handler({ listingId: LISTING, published: true }, ctx);
    expect(mockBackendRequest.mock.calls[0][2].timeoutMs).toBe(LISTING_WRITE_TIMEOUT_MS);
  });

  it('describes every field publishing actually requires', () => {
    expect(setListingPublished.description).toMatch(/a category, a location, a description of at least 20 characters and a price above 0/);
  });
});

describe('get_experience_details forwards the caller token', () => {
  it('sends it on both the detail and the schedules request when ctx has one', async () => {
    mockBackendRequest
      .mockResolvedValueOnce({ success: true, experience: { id: EXPERIENCE, status: 'draft' } })
      .mockResolvedValueOnce({ success: true, schedules: [] });
    const result = await getExperienceDetails.handler({ experienceId: EXPERIENCE }, ctx);
    expect(result.isError).toBeUndefined();
    expect(mockBackendRequest.mock.calls[0][2]?.token).toBe(ctx.token);
    expect(mockBackendRequest.mock.calls[1][2]?.token).toBe(ctx.token);
  });

  it('still works with no token, for an anonymous read', async () => {
    mockBackendRequest
      .mockResolvedValueOnce({ success: true, experience: { id: EXPERIENCE, status: 'published' } })
      .mockResolvedValueOnce({ success: true, schedules: [] });
    const result = await getExperienceDetails.handler({ experienceId: EXPERIENCE }, { ...ctx, token: undefined });
    expect(result.isError).toBeUndefined();
  });

  it('says a host sees their own draft or archived experience here', () => {
    expect(getExperienceDetails.description).toMatch(/host also sees their own draft or archived experience/);
  });
});

describe('delete_experience', () => {
  it('sends DELETE with the token and returns { deleted, experienceId }', async () => {
    mockBackendRequest.mockResolvedValue(undefined);
    const result = await deleteExperience.handler({ experienceId: EXPERIENCE }, ctx);
    const [method, path, opts] = mockBackendRequest.mock.calls[0];
    expect([method, path]).toEqual(['DELETE', `/packages/${EXPERIENCE}`]);
    expect(opts.token).toBe(ctx.token);
    expect(result.isError).toBeUndefined();
    expect(data(result)).toEqual({ deleted: true, experienceId: EXPERIENCE });
  });

  it('is registered, and a 409 comes back as isError with the Conflict text', async () => {
    expect(vendorTools.some((t) => t.name === 'delete_experience')).toBe(true);
    mockBackendRequest.mockRejectedValue(new BackendApiError(409, 'Experience has confirmed bookings'));
    const result = await deleteExperience.handler({ experienceId: EXPERIENCE }, ctx);
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('Conflict: Experience has confirmed bookings');
  });
});

describe('create_experience and update_experience accept guidanceType and pricingMode', () => {
  const base = { title: 'Sunset kayak tour', description: 'A guided two-hour paddle at golden hour.', duration: 2, durationUnit: 'hours', pricePerPerson: 60 };

  it('create_experience forwards both to the backend', async () => {
    mockBackendRequest.mockResolvedValue({ id: EXPERIENCE });
    // flat_rate also needs flatRatePrice and guidanceType staff_guided (see the dedicated block below); supply both here too.
    const parsed = z.object(createExperience.inputSchema).parse({ ...base, guidanceType: 'staff_guided', pricingMode: 'flat_rate', flatRatePrice: 150 });
    const result = await createExperience.handler(parsed, ctx);
    expect(result.isError).toBeUndefined();
    expect(mockBackendRequest.mock.calls[0][2].body).toMatchObject({ guidanceType: 'staff_guided', pricingMode: 'flat_rate' });
  });

  it('update_experience forwards both too', async () => {
    mockBackendRequest.mockResolvedValue({ id: EXPERIENCE });
    const parsed = z.object(updateExperience.inputSchema).parse({ experienceId: EXPERIENCE, guidanceType: 'self_guided', pricingMode: 'per_person' });
    const result = await updateExperience.handler(parsed, ctx);
    expect(result.isError).toBeUndefined();
    expect(mockBackendRequest.mock.calls[0][2].body).toMatchObject({ guidanceType: 'self_guided', pricingMode: 'per_person' });
  });

  it('rejects any other value for either field', () => {
    const shape = z.object(createExperience.inputSchema);
    expect(shape.safeParse({ ...base, guidanceType: 'robot_guided' }).success).toBe(false);
    expect(shape.safeParse({ ...base, pricingMode: 'subscription' }).success).toBe(false);
  });
});

describe('create_experience checks pricePerPerson vs flatRatePrice by pricingMode', () => {
  const base = { title: 'Sunset kayak tour', description: 'A guided two-hour paddle at golden hour.', duration: 2, durationUnit: 'hours' };

  it('the SDK now parses a flat_rate package with no pricePerPerson at all', () => {
    const parsed = z.object(createExperience.inputSchema).parse({ ...base, pricingMode: 'flat_rate', guidanceType: 'staff_guided', flatRatePrice: 150 });
    expect(parsed).not.toHaveProperty('pricePerPerson');
    expect(parsed.flatRatePrice).toBe(150);
  });

  it('refuses flat_rate without a positive flatRatePrice, before calling the backend', async () => {
    const parsed = z.object(createExperience.inputSchema).parse({ ...base, pricingMode: 'flat_rate', guidanceType: 'staff_guided' });
    const result = await createExperience.handler(parsed, ctx);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/flatRatePrice/);
    expect(mockBackendRequest).not.toHaveBeenCalled();
  });

  it('refuses flat_rate without guidanceType staff_guided, before calling the backend', async () => {
    const parsed = z.object(createExperience.inputSchema).parse({ ...base, pricingMode: 'flat_rate', flatRatePrice: 150 });
    const result = await createExperience.handler(parsed, ctx);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/guidanceType staff_guided/);
    expect(mockBackendRequest).not.toHaveBeenCalled();
  });

  it('refuses the default per_person mode without pricePerPerson, before calling the backend', async () => {
    const parsed = z.object(createExperience.inputSchema).parse({ ...base });
    const result = await createExperience.handler(parsed, ctx);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/pricePerPerson/);
    expect(mockBackendRequest).not.toHaveBeenCalled();
  });

  it('accepts and forwards a valid flat_rate package', async () => {
    mockBackendRequest.mockResolvedValue({ id: EXPERIENCE });
    const parsed = z.object(createExperience.inputSchema).parse({ ...base, pricingMode: 'flat_rate', guidanceType: 'staff_guided', flatRatePrice: 150 });
    const result = await createExperience.handler(parsed, ctx);
    expect(result.isError).toBeUndefined();
    expect(mockBackendRequest.mock.calls[0][2].body).toMatchObject({ flatRatePrice: 150, pricingMode: 'flat_rate', guidanceType: 'staff_guided' });
  });

  it('update_experience forwards flatRatePrice too', async () => {
    mockBackendRequest.mockResolvedValue({ id: EXPERIENCE });
    const parsed = z.object(updateExperience.inputSchema).parse({ experienceId: EXPERIENCE, flatRatePrice: 200 });
    const result = await updateExperience.handler(parsed, ctx);
    expect(result.isError).toBeUndefined();
    expect(mockBackendRequest.mock.calls[0][2].body).toMatchObject({ flatRatePrice: 200 });
  });
});

describe('set_dynamic_pricing_config accepts null to clear minPrice/maxPrice', () => {
  it('the schema accepts null for either field', () => {
    const shape = z.object(setDynamicPricingConfig.inputSchema);
    expect(shape.safeParse({ listingId: LISTING, minPrice: null }).success).toBe(true);
    expect(shape.safeParse({ listingId: LISTING, maxPrice: null }).success).toBe(true);
  });

  it('forwards null in the body', async () => {
    mockBackendRequest.mockResolvedValue({ listingId: LISTING, minPrice: null });
    const parsed = z.object(setDynamicPricingConfig.inputSchema).parse({ listingId: LISTING, minPrice: null });
    const result = await setDynamicPricingConfig.handler(parsed, ctx);
    expect(result.isError).toBeUndefined();
    expect(mockBackendRequest.mock.calls[0][2].body).toEqual({ minPrice: null });
  });

  it('still refuses minPrice > maxPrice when both are plain numbers', async () => {
    const result = await setDynamicPricingConfig.handler({ listingId: LISTING, minPrice: 100, maxPrice: 50 }, ctx);
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('minPrice must not exceed maxPrice.');
    expect(mockBackendRequest).not.toHaveBeenCalled();
  });
});

describe('calendar feeds accept treatFreeAllDayAsBusy', () => {
  const FEED = '44444444-4444-4444-8444-444444444444';

  it('add_calendar_feed forwards it in the body', async () => {
    mockBackendRequest.mockResolvedValue({ feed: { id: FEED }, importedCount: 0, removedCount: 0 });
    const parsed = z.object(addCalendarFeed.inputSchema).parse({ listingId: LISTING, url: 'https://calendar.example/a.ics', treatFreeAllDayAsBusy: false });
    const result = await addCalendarFeed.handler(parsed, ctx);
    expect(result.isError).toBeUndefined();
    expect(mockBackendRequest.mock.calls[0][2].body).toMatchObject({ treatFreeAllDayAsBusy: false });
  });

  it('update_calendar_feed forwards it, and it alone satisfies "pass at least one field"', async () => {
    mockBackendRequest.mockResolvedValue({ id: FEED });
    const parsed = z.object(updateCalendarFeed.inputSchema).parse({ feedId: FEED, treatFreeAllDayAsBusy: true });
    const result = await updateCalendarFeed.handler(parsed, ctx);
    expect(result.isError).toBeUndefined();
    expect(mockBackendRequest.mock.calls[0][2].body).toMatchObject({ treatFreeAllDayAsBusy: true });
  });

  it('sync_calendar_feed says a paused feed can still be synced by hand', () => {
    expect(syncCalendarFeed.description).toMatch(/paused feed can still be synced by hand/);
  });
});

describe('pricing and blackout descriptions point at the right follow-up tool', () => {
  it('the seasonal-rules note names applyWeekendPremium', () => {
    expect(createRateRule.description).toContain('applyWeekendPremium');
  });

  it('remove_blackout_date explains the sync suppression and clear_feed_suppression', () => {
    expect(removeBlackoutDate.description).toMatch(/suppression/);
    expect(removeBlackoutDate.description).toContain('clear_feed_suppression');
  });
});

// ── SPLIT-1608 remaining fixes (B1-B3) ───────────────────────────────────────

describe('B1: a vendor cannot misread their own transactions as income', () => {
  it('list_my_transactions and get_transaction both say these are the caller\'s own ledger, not a vendor income report', () => {
    for (const tool of [listMyTransactions, getTransaction]) {
      expect(tool.description).toMatch(/own ledger/);
      expect(tool.description).toContain('get_vendor_earnings');
      expect(tool.description).toContain('get_vendor_payouts');
    }
  });

  it('list_my_transactions says a PAYMENT row is a payment this account made, not income', () => {
    expect(listMyTransactions.description).toMatch(/PAYMENT row is a payment this account made/);
    expect(listMyTransactions.description).toMatch(/for example, as a renter/);
  });

  it('get_transaction explains whose share vendorPayout is', () => {
    expect(getTransaction.description).toMatch(/vendorPayout is the share of that booking's vendor/);
    expect(getTransaction.description).toMatch(/that vendor is someone else, not this account's income/);
  });
});

describe('B2: delete_service warns that it cascades even to paid bookings', () => {
  it('says it cannot be undone and prefers taking the service offline', () => {
    expect(deleteService.description).toMatch(/every booking and review/);
    expect(deleteService.description).toMatch(/including confirmed or paid bookings/);
    expect(deleteService.description).toMatch(/cannot be undone/);
    expect(deleteService.description).toContain('update_service(status="archived")');
    expect(deleteService.description).toMatch(/Confirm with the user/);
  });

  it('only names update_service(status="archived") because that field genuinely exists', () => {
    expect(Object.keys(updateService.inputSchema)).toContain('status');
    expect(z.object(updateService.inputSchema).shape.status.unwrap().options).toContain('archived');
  });

  it('keeps the DESTRUCTIVE annotation', () => {
    expect(deleteService.annotations.destructiveHint).toBe(true);
  });
});

describe('B3: get_booking_quote hints a vendor toward moderation when their own listing 404s', () => {
  const quoteArgs = { listingId: LISTING, startDate: '2027-03-01', endDate: '2027-03-03' };
  const vendorCtx: ToolContext = { userId: 'v', role: 'vendor_owner', token: 'T', kind: 'oauth' };
  const renterCtx: ToolContext = { userId: 'r', role: 'renter', token: 'T', kind: 'oauth' };

  it('appends the publish/approval hint for a vendor-family caller on a 404', async () => {
    mockBackendRequest.mockRejectedValue(new BackendApiError(404, 'Listing not found'));
    const result = await getBookingQuote.handler(quoteArgs, vendorCtx);
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Not found: Listing not found If this is one of your own listings, quotes work only once it is published and approved by Splitt's review.");
  });

  it('leaves a renter\'s or anonymous 404 exactly as the backend said', async () => {
    mockBackendRequest.mockRejectedValue(new BackendApiError(404, 'Listing not found'));
    const asRenter = await getBookingQuote.handler(quoteArgs, renterCtx);
    expect(text(asRenter)).toBe('Not found: Listing not found');

    mockBackendRequest.mockRejectedValue(new BackendApiError(404, 'Listing not found'));
    const anonymous = await getBookingQuote.handler(quoteArgs, { kind: 'operator' });
    expect(text(anonymous)).toBe('Not found: Listing not found');
  });

  it('does not touch a non-404 failure', async () => {
    mockBackendRequest.mockRejectedValue(new BackendApiError(409, 'Conflict'));
    const result = await getBookingQuote.handler(quoteArgs, vendorCtx);
    expect(text(result)).toBe('Conflict: Conflict');
  });

  it('says in its own description that quotes need a published, approved listing', () => {
    expect(getBookingQuote.description).toMatch(/published, Splitt-approved listing/);
  });
});
