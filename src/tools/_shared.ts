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
    if (error instanceof BackendApiError) return { ok: false, error: error.message, status: error.status };
    return { ok: false, error: 'Unexpected error talking to Splitt' };
  }
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Validate an ISO date (YYYY-MM-DD or full timestamp); returns a message or null. */
export function dateError(label: string, value: string): string | null {
  if (Number.isNaN(new Date(value).getTime())) return `Invalid ${label}: "${value}". Use an ISO date such as 2026-07-01.`;
  return null;
}

export function dateRangeError(start: string, end: string, maxDays = 365): string | null {
  const s = dateError('startDate', start);
  if (s) return s;
  const e = dateError('endDate', end);
  if (e) return e;
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (endMs <= startMs) return 'endDate must be after startDate.';
  if (endMs - startMs > maxDays * 86_400_000) return `Date range too long (max ${maxDays} days).`;
  return null;
}
