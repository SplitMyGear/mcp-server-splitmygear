/**
 * SPLIT-1606: blackout dates are inclusive at the tool boundary.
 *
 * The backend stores a blackout half-open, [startDate, endDate): endDate is the
 * day AFTER the last blocked day (one day D is [D, D+1)), and it rejects a
 * start that is not before the end. The web calendar converts both ways
 * (splitmygear-frontend components/BlackoutManager.tsx). These tools speak the
 * way a vendor does, "block March 1 to 2", so they convert here: the end goes
 * out as the last day + 1, and whole-day rows come back with endDate - 1.
 * Forwarding the last day unchanged left it bookable and made a single-day
 * block (start = end) a 400.
 */
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * The calendar day an ISO date or timestamp starts with, as written (no
 * timezone shift), or null when it is not a real day (2026-02-30).
 */
export function isoDay(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = ISO_DAY.exec(value);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** `day` (YYYY-MM-DD) moved by `days` calendar days. */
export function shiftDay(day: string, days: number): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
}

/**
 * A stored blackout with `endDate` as its last blocked day. A timed hold (one
 * day with startTime and endTime) and any row without a readable, later end are
 * returned as stored.
 */
export function toInclusiveBlackout<T>(row: T): T {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const stored = row as Record<string, unknown>;
  if (stored.startTime) return row;
  const start = isoDay(stored.startDate);
  const end = isoDay(stored.endDate);
  if (!start || !end || end <= start) return row;
  return { ...stored, endDate: shiftDay(end, -1) } as T;
}
