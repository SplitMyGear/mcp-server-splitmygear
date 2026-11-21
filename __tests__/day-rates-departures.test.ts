/**
 * SPLIT-1947 (day rates) and SPLIT-1949 (fixed departures): the MCP side of
 * backend SPLIT-1945/1946/1948 (v2.117.0). Exact method/path/body per call,
 * the client-side departure check that keeps create_booking on the grid, the
 * "from $X" search summary, and a contract rail over the vendored backend spec.
 */
export {};
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import type { components } from '../src/generated/api-types.gen';

const mockBackendRequest = jest.fn();
jest.mock('../src/lib/backend-client', () => {
  class BackendApiError extends Error {
    status: number;
    code?: string;
    constructor(status: number, message: string, code?: string) {
      super(message);
      this.name = 'BackendApiError';
      this.status = status;
      if (code !== undefined) this.code = code;
    }
  }
  return { BackendApiError, backendRequest: (...args: unknown[]) => mockBackendRequest(...args) };
});

import { bookingTools } from '../src/tools/bookings';
import { pricingRulesApi } from '../src/tools/pricing-rules';
import { createRateRule, updateRateRule, applyStarterSeasons } from '../src/tools/defs/pricing-rules';
import { searchListings, getBookingQuote, listDepartures, getListingCalendar } from '../src/tools/defs/discovery';
import { createBooking } from '../src/tools/defs/renter';
import { createListing, updateListing } from '../src/tools/defs/vendor';
import { addFleetUnits, updateFleetUnit } from '../src/tools/defs/fleet';
import { summarizeListing, fromPriceLabel } from '../src/tools/summaries';
import { pickDeparture, normalizeFixedSlots, type FixedSlot } from '../src/tools/fixed-slots';

const { BackendApiError } = jest.requireMock('../src/lib/backend-client');
const T = 'h.p.s';
const L = '11111111-1111-4111-8111-111111111111';
const R = '22222222-2222-4222-8222-222222222222';
const U = '33333333-3333-4333-8333-333333333333';
const DAY = '2027-03-06';
const vendorCtx = { token: T, role: 'vendor', userId: 'v1' };
const renterCtx = { token: T, role: 'renter', userId: 'r1' };
const publicCtx = { role: 'admin', kind: 'operator' as const };

const SLOTS: FixedSlot[] = [
  { startTime: '09:00', endTime: '10:30', remainingUnits: 2, available: true, price: 425 },
  { startTime: '13:00', endTime: '14:30', remainingUnits: 0, available: false, price: 425 },
  { startTime: '16:00', endTime: '17:30', remainingUnits: 1, available: true, price: 399.5 },
];

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}
function json(result: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  return JSON.parse(text(result));
}
const calls = (method: string, p: string | RegExp) =>
  mockBackendRequest.mock.calls.filter((c) => c[0] === method && (typeof p === 'string' ? c[1] === p : p.test(c[1])));

/** A backend where `calendarDay` is what GET /rentals/:id/availability/calendar answers for DAY. */
function backend(calendarDay: Record<string, unknown> | Error, overrides: Partial<Record<string, (body: unknown) => unknown>> = {}) {
  mockBackendRequest.mockImplementation(async (method: string, p: string, opts: { body?: unknown } = {}) => {
    if (method === 'GET' && p.includes('/availability/calendar')) {
      if (calendarDay instanceof Error) throw calendarDay;
      return [{ startDate: `${DAY}T00:00:00.000Z`, ...calendarDay }, { startDate: '2027-03-07T00:00:00.000Z', isAvailable: true }];
    }
    if (method === 'POST' && p === '/bookings/quote') return overrides.quote ? overrides.quote(opts.body) : { total: 425, nights: 0, dayRate: { unit: 'slot', rate: 425, ruleName: null } };
    if (method === 'POST' && p === '/bookings') return overrides.create ? overrides.create(opts.body) : { id: 'b1', status: 'draft' };
    if (method === 'POST' && p === '/payments/checkout-session') return { checkoutUrl: 'https://checkout.stripe.com/x' };
    if (overrides[`${method} ${p}`]) return overrides[`${method} ${p}`]!(opts.body);
    throw new Error(`unexpected ${method} ${p}`);
  });
}

beforeEach(() => {
  mockBackendRequest.mockReset();
});

// ── SPLIT-1947: rate rules for gear (day, hour, departure rates) ─────────────

describe('rate rules carry day, hourly and departure rates', () => {
  it('sends hourlyRate and slotRate on create and a null clear on update', async () => {
    mockBackendRequest.mockResolvedValue({ id: R });
    await pricingRulesApi.createRateRule(T, L, { name: 'Saturdays', startDate: '2027-01-01', endDate: '2028-01-01', weekdayMask: [6], nightlyRate: 60, hourlyRate: 15 });
    expect(mockBackendRequest).toHaveBeenLastCalledWith('POST', `/rentals/${L}/rate-rules`, {
      token: T,
      body: { name: 'Saturdays', startDate: '2027-01-01', endDate: '2028-01-01', weekdayMask: [6], nightlyRate: 60, hourlyRate: 15 },
    });
    await pricingRulesApi.updateRateRule(T, R, { slotRate: 425, hourlyRate: null });
    expect(mockBackendRequest).toHaveBeenLastCalledWith('PATCH', `/rentals/rate-rules/${R}`, { token: T, body: { slotRate: 425, hourlyRate: null } });
  });

  it('create_rate_rule lets absolute rates combine but refuses any of them with ratePct, before calling Splitt', async () => {
    for (const rate of [{ hourlyRate: 15 }, { slotRate: 425 }, { nightlyRate: 60 }]) {
      const res = await createRateRule.handler({ listingId: L, name: 'x', startDate: '2027-01-01', endDate: '2027-01-02', ratePct: 10, ...rate }, vendorCtx);
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(new RegExp(`${Object.keys(rate)[0]} and ratePct are mutually exclusive`));
    }
    expect(mockBackendRequest).not.toHaveBeenCalled();
    mockBackendRequest.mockResolvedValue({ id: R });
    const res = await createRateRule.handler({ listingId: L, name: 'Sat', startDate: '2027-01-01', endDate: '2028-01-01', weekdayMask: [6], nightlyRate: 60, hourlyRate: 15 }, vendorCtx);
    expect(res.isError).toBeUndefined();
    expect(mockBackendRequest.mock.calls[0][2].body).toEqual({ name: 'Sat', startDate: '2027-01-01', endDate: '2028-01-01', weekdayMask: [6], nightlyRate: 60, hourlyRate: 15 });
  });

  it('update_rate_rule forwards a slotRate change and refuses slotRate with ratePct', async () => {
    let res = await updateRateRule.handler({ ruleId: R, slotRate: 425, ratePct: 5 }, vendorCtx);
    expect(res.isError).toBe(true);
    expect(mockBackendRequest).not.toHaveBeenCalled();
    mockBackendRequest.mockResolvedValue({ id: R });
    res = await updateRateRule.handler({ ruleId: R, slotRate: 425 }, vendorCtx);
    expect(res.isError).toBeUndefined();
    expect(mockBackendRequest).toHaveBeenLastCalledWith('PATCH', `/rentals/rate-rules/${R}`, { token: T, body: { slotRate: 425 } });
  });

  it('the schema bounds hourlyRate and slotRate like the backend DTO (0.01 to 100000, cents)', () => {
    const schema = z.object(createRateRule.inputSchema);
    const base = { listingId: L, name: 'x', startDate: '2027-01-01', endDate: '2027-01-02' };
    expect(schema.safeParse({ ...base, slotRate: 425.5 }).success).toBe(true);
    expect(schema.safeParse({ ...base, hourlyRate: 0 }).success).toBe(false);
    expect(schema.safeParse({ ...base, slotRate: 100_001 }).success).toBe(false);
    expect(schema.safeParse({ ...base, hourlyRate: 1.234 }).success).toBe(false);
  });

  it('descriptions no longer say rate rules are stays-only; starter seasons still are', () => {
    expect(createRateRule.description).not.toMatch(/apply to stays only/);
    expect(createRateRule.description).toMatch(/weekdayMask/);
    expect(applyStarterSeasons.description).toMatch(/stays \(bookingType nightly\) only/);
  });
});

describe('search shows "from $X" only when the rates vary', () => {
  const base = { id: L, name: 'Kayak', bookingType: 'daily', pricePerDay: '50.00' };

  it('adds fromPrice when the lowest rate is below the highest, per unit priced', () => {
    expect(fromPriceLabel({ ...base, hasRateRules: true, priceFromDay: '45.00', priceToDay: '60.00' })).toBe('from $45/day');
    expect(fromPriceLabel({ ...base, bookingType: 'nightly', priceFromDay: '89.50', priceToDay: '120.00' })).toBe('from $89.50/night');
    expect(fromPriceLabel({ ...base, bookingType: 'both', priceFromDay: '45.00', priceToDay: '60.00', priceFromHour: '10.00', priceToHour: '15.00' })).toBe('from $45/day; from $10/hour');
    expect(fromPriceLabel({ ...base, bookingType: 'hourly', priceFromSlot: '399.00', priceToSlot: '425.00' })).toBe('from $399/departure');
  });

  it('leaves the row exactly as before when there are no rules or the rules never move the price', () => {
    const before = summarizeListing(base);
    expect(summarizeListing({ ...base, hasRateRules: false, priceFromDay: null, priceToDay: null, priceFromHour: null, priceToHour: null, priceFromSlot: null, priceToSlot: null })).toEqual(before);
    expect(summarizeListing({ ...base, hasRateRules: true, priceFromDay: '50.00', priceToDay: '50.00' })).toEqual(before);
    const varied = summarizeListing({ ...base, hasRateRules: true, priceFromDay: '45.00', priceToDay: '60.00' }) as Record<string, unknown>;
    expect(varied).toEqual({ ...(before as Record<string, unknown>), fromPrice: 'from $45/day' });
  });

  it('search_listings returns the fromPrice line from the browse payload', async () => {
    mockBackendRequest.mockResolvedValue({ data: [{ ...base, hasRateRules: true, priceFromDay: '45.00', priceToDay: '60.00' }, base], page: 1, limit: 50, total: 2 });
    const res = json(await searchListings.handler({ category: undefined }, publicCtx));
    const rows = res.listings as Array<Record<string, unknown>>;
    expect(rows[0].fromPrice).toBe('from $45/day');
    expect(rows[0]).not.toHaveProperty('priceFromDay');
    expect(rows[1]).not.toHaveProperty('fromPrice');
  });
});

describe('get_booking_quote returns the server quote, hourly and fixed windows included', () => {
  it('passes POST /bookings/quote through untouched, dayRate included', async () => {
    const quote = { total: 120, nights: 0, nightlyRates: [], dayRate: { unit: 'hour', rate: 15, ruleName: 'Saturdays' } };
    backend({}, { quote: () => quote });
    const res = await getBookingQuote.handler({ listingId: L, startDate: DAY, startTime: '09:00', endTime: '17:00' }, publicCtx);
    expect(json(res)).toEqual(quote);
    const [, , opts] = calls('POST', '/bookings/quote')[0];
    expect(opts.body).toEqual({ listingId: L, startDate: DAY, endDate: DAY, startTime: '09:00', endTime: '17:00' });
    expect(opts.token).toBeUndefined();
  });

  it('keeps day rentals as before and validates hourly input before calling Splitt', async () => {
    backend({}, { quote: () => ({ total: 100, nightlyRates: [{ date: DAY, rate: 60, ruleName: 'Saturdays' }] }) });
    let res = await getBookingQuote.handler({ listingId: L, startDate: DAY, endDate: '2027-03-08' }, publicCtx);
    expect(json(res)).toMatchObject({ nightlyRates: [{ date: DAY, rate: 60, ruleName: 'Saturdays' }] });
    expect(calls('POST', '/bookings/quote')[0][2].body).toEqual({ listingId: L, startDate: DAY, endDate: '2027-03-08' });
    mockBackendRequest.mockClear();
    for (const bad of [
      { listingId: L, startDate: DAY },
      { listingId: L, startDate: DAY, startTime: '09:00' },
      { listingId: L, startDate: DAY, endDate: '2027-03-07', startTime: '09:00', endTime: '10:00' },
      { listingId: L, startDate: DAY, startTime: '10:00', endTime: '09:00' },
    ]) {
      res = await getBookingQuote.handler(bad, publicCtx);
      expect(res.isError).toBe(true);
    }
    expect(mockBackendRequest).not.toHaveBeenCalled();
  });

  it('maps FIXED_SLOT_REQUIRED to the departures still open that day', async () => {
    backend({ fixedSlots: SLOTS }, {
      quote: () => {
        throw new BackendApiError(400, 'This listing runs on fixed departure times. Choose one of the listed departures.', 'FIXED_SLOT_REQUIRED');
      },
    });
    const res = await getBookingQuote.handler({ listingId: L, startDate: DAY, startTime: '09:15', endTime: '10:45' }, publicCtx);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/fixed departure times/);
    expect(text(res)).toContain('09:00-10:30 ($425, 2 left), 16:00-17:30 ($399.50, 1 left)');
    expect(text(res)).not.toContain('13:00');
  });
});

// ── SPLIT-1949: fixed departures ─────────────────────────────────────────────

describe('list_departures', () => {
  it('reads one day of fixedSlots from the availability calendar the way the web form does', async () => {
    backend({ isAvailable: true, fixedSlots: SLOTS });
    const res = json(await listDepartures.handler({ listingId: L, date: DAY }, publicCtx));
    expect(calls('GET', /availability\/calendar/)[0][1]).toBe(`/rentals/${L}/availability/calendar?from=${DAY}&to=2027-03-07`);
    expect(res).toEqual({ date: DAY, fixedDepartures: true, departures: SLOTS, openCount: 2 });
  });

  it('says so for a listing without fixed departures, and surfaces calendar errors', async () => {
    backend({ isAvailable: true, pricePerHour: 15 });
    expect(json(await listDepartures.handler({ listingId: L, date: DAY }, publicCtx))).toMatchObject({ fixedDepartures: false });
    backend(new BackendApiError(404, 'Listing not found'));
    const res = await listDepartures.handler({ listingId: L, date: DAY }, publicCtx);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Not found/);
  });

  it('get_listing_calendar documents fixedSlots and pricePerHour', () => {
    expect(getListingCalendar.description).toContain('fixedSlots');
    expect(getListingCalendar.description).toContain('pricePerHour');
  });
});

describe('pickDeparture / normalizeFixedSlots', () => {
  it('accepts only an open departure, derives endTime and checks quantity', () => {
    expect(pickDeparture(DAY, SLOTS, '09:00', undefined, 1)).toEqual({ ok: true, slot: SLOTS[0] });
    expect(pickDeparture(DAY, SLOTS, '09:00', '10:30', 2)).toEqual({ ok: true, slot: SLOTS[0] });
    expect(pickDeparture(DAY, SLOTS, '09:00', '11:00', 1)).toMatchObject({ ok: false, error: expect.stringMatching(/returns at 10:30/) });
    expect(pickDeparture(DAY, SLOTS, '16:00', undefined, 2)).toMatchObject({ ok: false, error: expect.stringMatching(/only 1 unit left/) });
    expect(pickDeparture(DAY, SLOTS, '13:00', undefined, 1)).toMatchObject({ ok: false, error: expect.stringMatching(/fully booked/) });
    expect(pickDeparture(DAY, SLOTS, '09:30', undefined, 1)).toMatchObject({ ok: false, error: expect.stringMatching(/not a departure time/) });
    expect(pickDeparture(DAY, [], '09:00', undefined, 1)).toMatchObject({ ok: false, error: expect.stringMatching(/no departures/) });
  });

  it('drops malformed slots and never trusts available without remaining units', () => {
    expect(normalizeFixedSlots([{ startTime: '9:00', endTime: '10:00' }, { startTime: '10:00', endTime: '11:00', remainingUnits: 0, available: true, price: '5' }, null])).toEqual([
      { startTime: '10:00', endTime: '11:00', remainingUnits: 0, available: false, price: 5 },
    ]);
    expect(normalizeFixedSlots(undefined)).toEqual([]);
  });
});

describe('create_booking never sends an off-grid window to a fixed-departure listing', () => {
  const book = (extra: Record<string, unknown>) => bookingTools.createBooking({ listingId: L, checkIn: DAY, token: T, ...extra });

  it('books a valid departure as one day with the departure times, like the web form', async () => {
    backend({ fixedSlots: SLOTS });
    const result = await book({ startTime: '09:00', quantity: 2 });
    expect(result).toMatchObject({ success: true, departure: SLOTS[0], booking: { id: 'b1' } });
    const expected = { listingId: L, startDate: DAY, endDate: DAY, startTime: '09:00', endTime: '10:30', quantity: 2 };
    expect(calls('POST', '/bookings/quote')[0][2].body).toEqual(expected);
    expect(calls('POST', '/bookings')[0][2]).toMatchObject({ token: T, body: { ...expected, totalPrice: 425 } });
  });

  it('refuses a missing, off-grid, full or mismatched departure before any quote or write, listing the open ones', async () => {
    backend({ fixedSlots: SLOTS });
    for (const [extra, pattern] of [
      [{ checkOut: '2027-03-08' }, /runs on fixed departure times[\s\S]*09:00-10:30/],
      [{ startTime: '09:15' }, /09:15 is not a departure time/],
      [{ startTime: '13:00' }, /fully booked/],
      [{ startTime: '09:00', endTime: '11:00' }, /returns at 10:30/],
      [{ startTime: '16:00', quantity: 2 }, /only 1 unit left/],
    ] as Array<[Record<string, unknown>, RegExp]>) {
      const result = await book(extra);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(pattern);
    }
    expect(calls('POST', '/bookings/quote')).toHaveLength(0);
    expect(calls('POST', '/bookings')).toHaveLength(0);
  });

  it('fails closed when the calendar cannot be read for a timed booking, but lets a day booking through', async () => {
    backend(new BackendApiError(504, 'Backend request timed out'));
    let result = await book({ startTime: '09:00' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/nothing was booked/);
    expect(calls('POST', '/bookings')).toHaveLength(0);
    backend(new BackendApiError(504, 'Backend request timed out'), { quote: () => ({ total: 100 }) });
    result = await book({ checkOut: '2027-03-08' });
    expect(result.success).toBe(true);
  });

  it('maps a backend FIXED_SLOT_REQUIRED (quote or booking) to a clear message and does not write after a refused quote', async () => {
    const refuse = () => {
      throw new BackendApiError(400, 'This listing runs on fixed departure times. Choose one of the listed departures.', 'FIXED_SLOT_REQUIRED');
    };
    // A listing that switched to fixed departures after the calendar was read.
    backend({ isAvailable: true }, { quote: refuse });
    let result = await book({ checkOut: '2027-03-08' });
    expect(result).toEqual({ success: false, error: expect.stringMatching(/fixed departure times[\s\S]*list_departures/) });
    expect(calls('POST', '/bookings')).toHaveLength(0);
    backend({ isAvailable: true }, { quote: () => ({ total: 100 }), create: refuse });
    result = await book({ checkOut: '2027-03-08' });
    expect(result.error).toMatch(/runs on fixed departure times: a booking must start at one of the published departures/);
  });

  it('sends a flexible hourly booking as one day with both times', async () => {
    backend({ isAvailable: true, pricePerHour: 15 }, { quote: () => ({ total: 120, dayRate: { unit: 'hour', rate: 15, ruleName: null } }) });
    const result = await book({ startTime: '09:00', endTime: '17:00' });
    expect(result).toMatchObject({ success: true, quote: { dayRate: { unit: 'hour', rate: 15 } } });
    expect(result).not.toHaveProperty('departure');
    expect(calls('POST', '/bookings')[0][2].body).toMatchObject({ startDate: DAY, endDate: DAY, startTime: '09:00', endTime: '17:00', totalPrice: 120 });
    mockBackendRequest.mockClear();
    expect((await book({ startTime: '09:00' })).error).toMatch(/needs both startTime and endTime/);
    expect((await book({ startTime: '09:00', endTime: '17:00', checkOut: '2027-03-07' })).error).toMatch(/single day/);
    expect((await book({ startTime: '9am', endTime: '17:00' })).error).toMatch(/HH:MM/);
    expect(calls('POST', '/bookings')).toHaveLength(0);
  });

  it('the create_booking tool exposes startTime/endTime, makes checkOut optional and still requires it for a day booking', async () => {
    const schema = z.object(createBooking.inputSchema);
    expect(schema.safeParse({ listingId: L, checkIn: DAY, startTime: '09:00' }).success).toBe(true);
    expect(schema.safeParse({ listingId: L, checkIn: DAY, startTime: '25:00' }).success).toBe(false);
    const res = await createBooking.handler({ listingId: L, checkIn: DAY, withPaymentLink: false }, renterCtx);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Pass checkOut/);
    expect(mockBackendRequest).not.toHaveBeenCalled();
    backend({ fixedSlots: SLOTS });
    const ok = json(await createBooking.handler({ listingId: L, checkIn: DAY, startTime: '16:00', withPaymentLink: true }, renterCtx));
    expect(ok).toMatchObject({ departure: SLOTS[2], paymentUrl: 'https://checkout.stripe.com/x' });
  });
});

describe('listing tools read and write slot mode, length and price', () => {
  it('create_listing requires hourly, a length and a price for fixed departures, and needs no pricePerHour then', async () => {
    const base = { name: 'Sunset cruise', description: 'Ninety minutes on the lake at sunset, captain included.' };
    for (const [args, pattern] of [
      [{ slotMode: 'fixed', slotDurationMinutes: 90, slotPrice: 425 }, /only available on hourly listings/],
      [{ bookingType: 'hourly', slotMode: 'fixed', slotPrice: 425 }, /need slotDurationMinutes/],
      [{ bookingType: 'hourly', slotMode: 'fixed', slotDurationMinutes: 90 }, /need slotPrice/],
    ] as Array<[Record<string, unknown>, RegExp]>) {
      const res = await createListing.handler({ ...base, ...args }, vendorCtx);
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(pattern);
    }
    expect(mockBackendRequest).not.toHaveBeenCalled();
    mockBackendRequest.mockResolvedValue({ id: L, slotMode: 'fixed' });
    const res = await createListing.handler({ ...base, bookingType: 'hourly', slotMode: 'fixed', slotDurationMinutes: 90, slotPrice: 425 }, vendorCtx);
    expect(res.isError).toBeUndefined();
    expect(mockBackendRequest.mock.calls[0][0]).toBe('POST');
    expect(mockBackendRequest.mock.calls[0][1]).toBe('/rentals');
    expect(mockBackendRequest.mock.calls[0][2].body).toMatchObject({ bookingType: 'hourly', slotMode: 'fixed', slotDurationMinutes: 90, slotPrice: 425 });
  });

  it('update_listing forwards the slot fields and refuses fixed with a non-hourly booking type', async () => {
    let res = await updateListing.handler({ listingId: L, slotMode: 'fixed', bookingType: 'daily' }, vendorCtx);
    expect(res.isError).toBe(true);
    expect(mockBackendRequest).not.toHaveBeenCalled();
    mockBackendRequest.mockResolvedValue({ id: L });
    res = await updateListing.handler({ listingId: L, slotMode: 'fixed', slotDurationMinutes: 120, slotPrice: 450 }, vendorCtx);
    expect(res.isError).toBeUndefined();
    expect(mockBackendRequest).toHaveBeenLastCalledWith('PUT', `/rentals/${L}`, expect.objectContaining({ body: { slotMode: 'fixed', slotDurationMinutes: 120, slotPrice: 450 } }));
    await updateListing.handler({ listingId: L, slotMode: 'flexible' }, vendorCtx);
    expect(mockBackendRequest.mock.calls[1][2].body).toEqual({ slotMode: 'flexible' });
  });

  it('bounds slotDurationMinutes to 15..1440 in 5-minute steps, like the backend', () => {
    const shape = z.object(updateListing.inputSchema).shape;
    for (const ok of [15, 90, 1440]) expect(shape.slotDurationMinutes.safeParse(ok).success).toBe(true);
    for (const bad of [10, 92, 1445, 60.5]) expect(shape.slotDurationMinutes.safeParse(bad).success).toBe(false);
    expect(shape.slotMode.safeParse('rigid').success).toBe(false);
  });
});

describe('fleet units carry their departure times', () => {
  it('update_fleet_unit sets and clears departureTimes', async () => {
    mockBackendRequest.mockResolvedValue({ id: U, departureTimes: ['09:00', '13:00'] });
    await updateFleetUnit.handler({ unitId: U, departureTimes: ['13:00', '09:00'] }, vendorCtx);
    expect(mockBackendRequest).toHaveBeenLastCalledWith('PUT', `/fleet/units/${U}`, { token: T, body: { departureTimes: ['13:00', '09:00'] } });
    await updateFleetUnit.handler({ unitId: U, departureTimes: null }, vendorCtx);
    expect(mockBackendRequest).toHaveBeenLastCalledWith('PUT', `/fleet/units/${U}`, { token: T, body: { departureTimes: null } });
  });

  it('add_fleet_units takes departureTimes for one unit, not in bulk mode', async () => {
    mockBackendRequest.mockResolvedValue({ id: U });
    await addFleetUnits.handler({ listingId: L, label: 'Boat 1', departureTimes: ['09:00'] }, vendorCtx);
    expect(mockBackendRequest).toHaveBeenLastCalledWith('POST', `/fleet/listings/${L}/units`, { token: T, body: { label: 'Boat 1', departureTimes: ['09:00'] } });
    mockBackendRequest.mockClear();
    const res = await addFleetUnits.handler({ listingId: L, count: 3, departureTimes: ['09:00'] }, vendorCtx);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/departureTimes/);
    expect(mockBackendRequest).not.toHaveBeenCalled();
  });

  it('accepts HH:MM only, at most 24 per unit', () => {
    const field = z.object(updateFleetUnit.inputSchema).shape.departureTimes;
    expect(field.safeParse(['00:00', '23:59']).success).toBe(true);
    expect(field.safeParse(['9:00']).success).toBe(false);
    expect(field.safeParse(['24:00']).success).toBe(false);
    expect(field.safeParse(Array.from({ length: 25 }, (_, i) => `${String(i % 24).padStart(2, '0')}:00`)).success).toBe(false);
  });
});

// ── Contract rail: the vendored backend spec covers every field these tools send or read ──

describe('openapi/openapi.json covers the day-rate and fixed-departure contract (backend v2.117.0)', () => {
  const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'openapi', 'openapi.json'), 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
    components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
  };
  const props = (name: string) => Object.keys(spec.components.schemas[name]?.properties ?? {});

  it('declares the request fields the tools send', () => {
    for (const dto of ['CreateRateRuleDto', 'UpdateRateRuleDto']) expect(props(dto)).toEqual(expect.arrayContaining(['nightlyRate', 'hourlyRate', 'slotRate', 'ratePct', 'weekdayMask']));
    for (const dto of ['CreateListingDto', 'UpdateListingDto']) expect(props(dto)).toEqual(expect.arrayContaining(['slotMode', 'slotDurationMinutes', 'slotPrice']));
    for (const dto of ['CreateUnitDto', 'UpdateUnitDto']) expect(props(dto)).toContain('departureTimes');
    for (const dto of ['QuoteBookingDto', 'CreateBookingDto']) expect(props(dto)).toEqual(expect.arrayContaining(['startTime', 'endTime']));
  });

  it('declares the listing and rule fields the tools read', () => {
    expect(props('Listing')).toEqual(
      expect.arrayContaining(['slotMode', 'slotDurationMinutes', 'slotPrice', 'hasRateRules', 'priceFromDay', 'priceToDay', 'priceFromHour', 'priceToHour', 'priceFromSlot', 'priceToSlot']),
    );
    expect(props('ListingRateRule')).toEqual(expect.arrayContaining(['nightlyRate', 'hourlyRate', 'slotRate']));
    expect(props('ListingUnit')).toContain('departureTimes');
  });

  it('declares the endpoints the tools call', () => {
    expect(Object.keys(spec.paths['/api/v1/rentals/{id}/rate-rules'] ?? {})).toEqual(expect.arrayContaining(['get', 'post']));
    expect(Object.keys(spec.paths['/api/v1/rentals/rate-rules/{ruleId}'] ?? {})).toEqual(expect.arrayContaining(['patch', 'delete']));
    expect(spec.paths['/api/v1/rentals/{id}/availability/calendar']).toHaveProperty('get');
    expect(spec.paths['/api/v1/bookings/quote']).toHaveProperty('post');
    expect(spec.paths['/api/v1/fleet/units/{unitId}']).toHaveProperty('put');
  });

  it('the generated types carry the same fields (compile-time rail)', () => {
    const rule: Pick<components['schemas']['CreateRateRuleDto'], 'hourlyRate' | 'slotRate'> = { hourlyRate: 15, slotRate: 425 };
    const unit: Pick<components['schemas']['UpdateUnitDto'], 'departureTimes'> = { departureTimes: ['09:00'] };
    const quote: Pick<components['schemas']['QuoteBookingDto'], 'startTime' | 'endTime'> = { startTime: '09:00', endTime: '10:30' };
    const listing: Pick<components['schemas']['UpdateListingDto'], 'slotMode' | 'slotDurationMinutes' | 'slotPrice'> = { slotMode: 'fixed', slotDurationMinutes: 90, slotPrice: 425 };
    expect([rule, unit, quote, listing]).toHaveLength(4);
  });
});
