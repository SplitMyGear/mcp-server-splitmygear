/**
 * Thin HTTP client for the SplitMyGear backend REST API (NestJS, /api/v1).
 *
 * SPLIT-226 (M4): user-scoped mutating tools no longer write to Supabase/Stripe
 * directly (which bypassed all backend auth, validation, server-authoritative
 * pricing and the real schema — the MCP's column assumptions diverged from the
 * backend entities). Instead they call the backend REST API forwarding the
 * caller's own JWT, so the backend remains the single authority for
 * authentication, RBAC, ownership, pricing and payments.
 */

const DEFAULT_BASE_URL = 'https://splitmygear-backend.vercel.app/api/v1';

/**
 * Per-request timeout. The function's Vercel `maxDuration` is 30s; without an
 * explicit bound a hung/slow backend ties the whole invocation up until that
 * hard limit and then surfaces as an opaque 500. Aborting at 15s keeps a single
 * upstream stall well inside the budget (leaving room for the create-booking
 * listing pre-fetch + the booking POST in one request) and turns the failure
 * into a structured 504 the tool handlers already know how to render.
 */
const REQUEST_TIMEOUT_MS = 15_000;

export function backendBaseUrl(): string {
  return process.env.BACKEND_API_URL || DEFAULT_BASE_URL;
}

export class BackendApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'BackendApiError';
    this.status = status;
  }
}

interface RequestOptions {
  /** The caller's backend JWT, forwarded as `Authorization: Bearer <token>`. */
  token?: string;
  body?: unknown;
  /**
   * Extra request headers (e.g. the trusted-relay client-IP headers the OAuth
   * login bridge sends so the backend's per-IP login throttle keys on the END
   * USER, not on this server's egress address). Never overrides Authorization.
   */
  headers?: Record<string, string>;
}

/**
 * Perform a backend request. Throws BackendApiError on a non-2xx response,
 * surfacing the backend's error message (the global filter returns
 * `{ statusCode, error, message }` where message is a string or string[]).
 */
export async function backendRequest<T = unknown>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(options.headers ?? {}) };
  if (options.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${backendBaseUrl()}${path}`, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      // AbortSignal.timeout (Node 18+/20) bounds every upstream call so a stalled
      // backend can't hang the serverless function to its maxDuration.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // A timeout abort, DNS failure, or connection reset reaches here as a raw
    // Error/DOMException. Normalize to a BackendApiError so callers' existing
    // `instanceof BackendApiError` handling renders a structured result instead
    // of an unhandled rejection that 500s the whole MCP request.
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new BackendApiError(
      isTimeout ? 504 : 502,
      isTimeout ? 'Backend request timed out' : 'Backend request failed (network error)',
    );
  }

  const raw = await response.text();
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    parsed = undefined;
  }

  if (!response.ok) {
    throw new BackendApiError(response.status, extractErrorMessage(parsed, response.status));
  }

  return parsed as T;
}

function extractErrorMessage(parsed: unknown, status: number): string {
  if (parsed && typeof parsed === 'object') {
    const body = parsed as { message?: unknown; error?: unknown };
    if (Array.isArray(body.message)) {
      return body.message.filter((m) => typeof m === 'string').join('; ') || `Request failed (${status})`;
    }
    if (typeof body.message === 'string') {
      return body.message;
    }
    if (typeof body.error === 'string') {
      return body.error;
    }
  }
  return `Backend request failed (${status})`;
}
