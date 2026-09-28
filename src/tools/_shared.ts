/**
 * Shared plumbing for tool backends: a `Result`-returning wrapper over
 * `backendRequest` (so tool handlers never throw on backend failures and every
 * error reaches the model as a structured `isError` result), plus tiny query
 * string / date helpers used across domains.
 */
import { backendRequest, BackendApiError } from '@/lib/backend-client';

export type Result<T> = { ok: true; data: T } | { ok: false; error: string; status?: number };

export interface CallOptions {
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export async function call<T = unknown>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  options: CallOptions = {},
): Promise<Result<T>> {
  try {
    const data = await backendRequest<T>(method, path, options);
    return { ok: true, data };
  } catch (error) {
    if (error instanceof BackendApiError) {
      if (error.status === 504 && method !== 'GET') return { ok: false, error: UNCONFIRMED_WRITE, status: 504 };
      return { ok: false, error: error.message, status: error.status };
    }
    return { ok: false, error: 'Unexpected error talking to Splitt' };
  }
}

/**
 * What a tool says when a write timed out. The backend may still finish it: on
 * 2026-09-28 a create_listing reported as failed was committed 8 s later, and
 * the natural retry would have created the listing twice (SPLIT-1608).
 */
export const UNCONFIRMED_WRITE =
  'Splitt did not answer in time, so this change may still have been made. Check the current state (list or open the item) before trying again: repeating it could make the change twice.';

/**
 * An AI text helper's outcome: the generated text, or why there is none. Never a
 * notice dressed up as text: returning the backend's "AI is switched off" message
 * AS the draft read to the model like a real draft, one it could paste into a
 * listing or a message.
 */
export type AiText = { ok: true; text: string } | { ok: false; error: string };

/**
 * The backend's AI routes answer 200 with `{ available: false, message }` when its
 * AI is switched off (FEATURE_AI_ENABLED, or FEATURE_AI_RENTER_ENABLED for the
 * renter-facing routes) and, for plan-trip, when a generation produced nothing
 * usable (`reason: 'generation-failed'`). Either way nothing was generated.
 */
export function isAiUnavailable(data: unknown): data is { available: false; message?: unknown } {
  return typeof data === 'object' && data !== null && (data as { available?: unknown }).available === false;
}

/** The tool error for an `available: false` answer: what happened, then what to do instead. */
export function aiUnavailableMessage(data: { message?: unknown }): string {
  const why = typeof data.message === 'string' && data.message.trim() ? data.message.trim() : "Splitt's AI is unavailable right now.";
  return `Nothing was generated: ${why} Write it yourself, or try again later.`;
}

/** Build `?a=b&c=d` from defined, non-empty values (URLSearchParams encodes everything). */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

/** Drop undefined values so bodies only carry fields the caller actually set
 *  (the backend's global ValidationPipe rejects unknown/undeclared fields). */
export function compact<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Validate an ISO date (YYYY-MM-DD or full timestamp); returns a message or null. */
export function dateError(label: string, value: string): string | null {
  if (Number.isNaN(new Date(value).getTime())) return `Invalid ${label}: "${value}". Use an ISO date such as 2026-07-01.`;
  return null;
}

export interface DateRangeOptions {
  /** The tool's own names for the two dates, so the message names what the caller sent (default startDate, endDate). */
  names?: readonly [string, string];
  /** A window whose last day is included may start and end on the same day (a calendar); a rental may not. */
  allowSameDay?: boolean;
}

export function dateRangeError(start: string, end: string, maxDays = 365, options: DateRangeOptions = {}): string | null {
  const [startName, endName] = options.names ?? ['startDate', 'endDate'];
  const s = dateError(startName, start);
  if (s) return s;
  const e = dateError(endName, end);
  if (e) return e;
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (options.allowSameDay ? endMs < startMs : endMs <= startMs) return `${endName} must be ${options.allowSameDay ? 'on or after' : 'after'} ${startName}.`;
  if (endMs - startMs > maxDays * 86_400_000) return `Date range too long (max ${maxDays} days).`;
  return null;
}
