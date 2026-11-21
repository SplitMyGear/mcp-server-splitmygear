/**
 * SPLIT-1949 (backend SPLIT-1948): fixed-departure ("fixed slot") rentals.
 *
 * A fixed-slot listing is an hourly listing whose renters cannot pick an
 * arbitrary window: each fleet unit publishes departure times and every
 * booking lasts exactly the listing's `slotDurationMinutes`. The backend
 * publishes each day's departures as `fixedSlots` on the public availability
 * calendar (`GET /rentals/:id/availability/calendar`, AvailabilityService
 * .getAvailableDates) and refuses any other window with a 400 carrying
 * `code: 'FIXED_SLOT_REQUIRED'` (BookingService.enforceBookingGuardrails), on
 * the quote as well as on the booking.
 *
 * The web booking form (frontend FixedSlotBookingForm) reads the calendar for
 * [day, day+1], offers that day's `fixedSlots`, and books with
 * `startDate = endDate = day` plus the slot's `startTime` / `endTime`. The MCP
 * does exactly the same, so a departure the web would refuse is never sent.
 */
import { isoDay, shiftDay } from './blackout-dates';
import { call, type Result } from './_shared';

/** The backend's error code for an off-grid window on a fixed-departure listing. */
export const FIXED_SLOT_REQUIRED = 'FIXED_SLOT_REQUIRED';

/** One departure on one day, as the backend's `FixedSlot` (listing/fixed-slots.ts). */
export interface FixedSlot {
  startTime: string;
  endTime: string;
  /** Units still bookable for exactly this departure. */
  remainingUnits: number;
  available: boolean;
  /** Price of ONE unit for this departure on this day (rate rules applied). */
  price: number;
}

/** What the calendar says about one day. `fixed: false` means the listing does not run on fixed departures. */
export type DayDepartures = { fixed: false } | { fixed: true; slots: FixedSlot[] };

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Only well-formed slots, in departure order; anything the backend might add later is dropped. */
export function normalizeFixedSlots(raw: unknown): FixedSlot[] {
  if (!Array.isArray(raw)) return [];
  const out: FixedSlot[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    if (typeof s.startTime !== 'string' || !HHMM.test(s.startTime)) continue;
    if (typeof s.endTime !== 'string' || !HHMM.test(s.endTime)) continue;
    const remainingUnits = Math.max(0, Math.floor(Number(s.remainingUnits) || 0));
    const price = Number(s.price);
    out.push({
      startTime: s.startTime,
      endTime: s.endTime,
      remainingUnits,
      available: s.available === true && remainingUnits > 0,
      price: Number.isFinite(price) ? price : 0,
    });
  }
  return out.sort((a, b) => a.startTime.localeCompare(b.startTime));
}

/**
 * The departures of `day` (YYYY-MM-DD). The calendar needs `to` after `from`,
 * so the day and the next are asked for and only `day` is read, as the web form
 * does. A day row WITHOUT `fixedSlots` is a listing that does not run on fixed
 * departures (the backend sets the field only for those, possibly to `[]`).
 */
export async function loadDayDepartures(listingId: string, day: string, timeoutMs?: number): Promise<Result<DayDepartures>> {
  const result = await call<unknown>(
    'GET',
    `/rentals/${listingId}/availability/calendar?from=${day}&to=${shiftDay(day, 1)}`,
    timeoutMs === undefined ? {} : { timeoutMs },
  );
  if (!result.ok) return result;
  const rows = Array.isArray(result.data) ? result.data : [];
  const row = rows.find((r) => isoDay((r as { startDate?: unknown } | null)?.startDate) === day) as { fixedSlots?: unknown } | undefined;
  if (!row || !Array.isArray(row.fixedSlots)) return { ok: true, data: { fixed: false } };
  return { ok: true, data: { fixed: true, slots: normalizeFixedSlots(row.fixedSlots) } };
}

function money(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/** "09:00-10:30 ($425, 2 left)" for every bookable departure, or a sentence saying there are none. */
export function describeDepartures(day: string, slots: readonly FixedSlot[], quantity = 1): string {
  const open = slots.filter((s) => s.available && s.remainingUnits >= quantity);
  if (open.length === 0) {
    return slots.length === 0
      ? `There are no departures on ${day}.`
      : `Every departure on ${day} is taken${quantity > 1 ? ` for ${quantity} units` : ''}. Try another day.`;
  }
  const list = open.map((s) => `${s.startTime}-${s.endTime} (${money(s.price)}, ${s.remainingUnits} left)`).join(', ');
  return `Departures still open on ${day}: ${list}.`;
}

/** The message for a fixed-departure listing asked for a window that is not one of its departures. */
export function fixedSlotRequiredMessage(day: string | null, slots?: readonly FixedSlot[], quantity = 1): string {
  const head =
    'This listing runs on fixed departure times: a booking must start at one of the published departures and last exactly the listing\'s rental length. ' +
    'Pass startTime (and optionally endTime) of one of them, with checkIn set to that day.';
  if (!day || !slots) return `${head} list_departures shows the departures for a day.`;
  return `${head} ${describeDepartures(day, slots, quantity)}`;
}

/**
 * The departure `startTime` (and `endTime`, when given) names on this day, or
 * the reason it cannot be booked. Strict on purpose: only a departure that is
 * still open for `quantity` units passes, so the MCP never sends a window the
 * backend would refuse as off-grid.
 */
export function pickDeparture(
  day: string,
  slots: readonly FixedSlot[],
  startTime: string | undefined,
  endTime: string | undefined,
  quantity = 1,
): { ok: true; slot: FixedSlot } | { ok: false; error: string } {
  if (!startTime) return { ok: false, error: fixedSlotRequiredMessage(day, slots, quantity) };
  const slot = slots.find((s) => s.startTime === startTime);
  if (!slot) return { ok: false, error: `${startTime} is not a departure time on ${day}. ${describeDepartures(day, slots, quantity)}` };
  if (endTime !== undefined && endTime !== slot.endTime) {
    return { ok: false, error: `The ${startTime} departure returns at ${slot.endTime}, not ${endTime}: every rental on this listing lasts the same length. Leave endTime out or pass ${slot.endTime}.` };
  }
  if (!slot.available || slot.remainingUnits < quantity) {
    const why = slot.remainingUnits > 0 ? `only ${slot.remainingUnits} unit${slot.remainingUnits === 1 ? '' : 's'} left` : 'it is fully booked';
    return { ok: false, error: `The ${startTime} departure on ${day} cannot be booked: ${why}. ${describeDepartures(day, slots, quantity)}` };
  }
  return { ok: true, slot };
}
