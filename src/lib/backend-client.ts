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
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }

  const response = await fetch(`${backendBaseUrl()}${path}`, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

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
