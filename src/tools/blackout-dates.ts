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
 * A stored blackout with `startDate` and `endDate` as its first and last
 * blocked days (plain days, even where the backend answers with a timestamp).
 * A timed hold (startTime and endTime) and any row without a readable, later
 * end are returned as stored.
 */
export function toInclusiveBlackout<T>(row: T): T {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const stored = row as Record<string, unknown>;
  if (stored.startTime) return row;
  const start = isoDay(stored.startDate);
  const end = isoDay(stored.endDate);
  if (!start || !end || end <= start) return row;
  return { ...stored, startDate: start, endDate: shiftDay(end, -1) } as T;
}

export interface BlackoutQuery {
  /** Only blocks with a day on or after this one (YYYY-MM-DD). */
  from?: string;
  /** Only blocks with a day on or before this one (YYYY-MM-DD). */
  to?: string;
  /** manual = added by the vendor; synced = imported from a calendar feed. */
  source?: 'all' | 'manual' | 'synced';
  limit?: number;
  offset?: number;
}

export const DEFAULT_BLACKOUT_PAGE = 50;

/**
 * One page of a listing's blocks, inclusive days, sorted by first day. A feed
 * with a few years of holidays holds more rows than fit in one answer, and the
 * list was cut at 128 of 152 with no way to reach the rest (SPLIT-1608).
 * A row whose days cannot be read is never filtered out: a block the vendor
 * cannot see is a block they cannot remove.
 */
export function pageBlackouts(rows: unknown, query: BlackoutQuery = {}): unknown {
  if (!Array.isArray(rows)) return rows;
  const from = query.from ? isoDay(query.from) : null;
  const to = query.to ? isoDay(query.to) : null;
  const matching = rows
    .map((row) => toInclusiveBlackout(row) as unknown)
    .filter((row) => matchesSource(row, query.source ?? 'all') && overlaps(row, from, to))
    .sort(byFirstDay);
  const offset = query.offset ?? 0;
  const limit = query.limit ?? DEFAULT_BLACKOUT_PAGE;
  return { total: matching.length, offset, items: matching.slice(offset, offset + limit) };
}

function field(row: unknown, key: string): unknown {
  return row && typeof row === 'object' ? (row as Record<string, unknown>)[key] : undefined;
}

function matchesSource(row: unknown, source: 'all' | 'manual' | 'synced'): boolean {
  if (source === 'all') return true;
  const synced = field(row, 'type') === 'sync' || Boolean(field(row, 'sourceFeedId'));
  return source === 'synced' ? synced : !synced;
}

function overlaps(row: unknown, from: string | null, to: string | null): boolean {
  const first = isoDay(field(row, 'startDate'));
  const last = isoDay(field(row, 'endDate')) ?? first;
  if (!first || !last) return true;
  return (!from || last >= from) && (!to || first <= to);
}

function byFirstDay(a: unknown, b: unknown): number {
  const x = isoDay(field(a, 'startDate')) ?? '';
  const y = isoDay(field(b, 'startDate')) ?? '';
  return x < y ? -1 : x > y ? 1 : 0;
}
