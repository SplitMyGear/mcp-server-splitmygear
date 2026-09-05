import { NextRequest } from 'next/server';
import { trustProxyHeaders, validIp } from '@/lib/oauth/config';
import { incrementWindow, sharedStoreEnabled } from '@/lib/shared-store';

/**
 * Rate limiter (M8 / SPLIT-254; distributed variant on top).
 *
 * Two layers, same tier table and same result shape:
 *
 * 1. SHARED STORE (Upstash Redis REST via `@/lib/shared-store`), used whenever
 *    it is configured. Fixed one-minute window keyed on the principal:
 *    `mcp:rl:<clientId>:<floor(now / 60s)>`, one INCR per request with the key
 *    expiring after the window. This is the true GLOBAL limit across every
 *    serverless instance.
 * 2. IN-MEMORY FALLBACK, used when no store is configured or the store is
 *    unavailable for a given request (the store module resolves `null` instead
 *    of throwing, so a Redis outage degrades to the best-effort limiter rather
 *    than failing every MCP call). It is PER INSTANCE: on Vercel each
 *    concurrent lambda has its own map, so it is defense-in-depth on top of the
 *    mandatory auth (operator API key or backend JWT bearer; see
 *    middleware/auth.ts). Stale entries are reclaimed lazily via a bounded
 *    inline sweep when the map grows, so there is no timer to leak.
 */

export const RATE_LIMITS = {
  internal: { requestsPerMinute: 100, toolCallsPerMinute: 1000 },
  beta: { requestsPerMinute: 50, toolCallsPerMinute: 500 },
  public: { requestsPerMinute: 20, toolCallsPerMinute: 200 },
  default: { requestsPerMinute: 10, toolCallsPerMinute: 100 },
} as const;

export interface RateLimitResult {
  success: boolean;
  error?: string;
  remaining?: number;
}

const WINDOW_MS = 60 * 1000;
const WINDOW_SECONDS = WINDOW_MS / 1000;
const MAX_ENTRIES = 10_000; // guardrail against unbounded growth
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

function sweep(now: number): void {
  for (const [key, value] of rateLimitStore.entries()) {
    if (now > value.resetTime) rateLimitStore.delete(key);
  }
}

function exceeded(limit: number): RateLimitResult {
  return {
    success: false,
    error: `Rate limit exceeded. Maximum ${limit} requests per minute.`,
    remaining: 0,
  };
}

/** Per-instance fixed window (the fallback layer). */
function limitLocally(clientId: string, limit: number, now: number): RateLimitResult {
  // Bounded inline cleanup (replaces the leaking setInterval): only sweep when
  // the map has grown, keeping per-call cost ~O(1) in the common case.
  if (rateLimitStore.size > MAX_ENTRIES) sweep(now);

  const clientData = rateLimitStore.get(clientId);

  if (!clientData || now > clientData.resetTime) {
    rateLimitStore.set(clientId, { count: 1, resetTime: now + WINDOW_MS });
    return { success: true, remaining: limit - 1 };
  }

  if (clientData.count >= limit) return exceeded(limit);

  clientData.count++;
  return { success: true, remaining: limit - clientData.count };
}

/**
 * Shared fixed window (the distributed layer). Resolves `null` when the store
 * is unavailable so the caller can fall back to the per-instance limiter for
 * this request only.
 */
async function limitShared(clientId: string, limit: number, now: number): Promise<RateLimitResult | null> {
  const windowId = Math.floor(now / WINDOW_MS);
  const count = await incrementWindow(`rl:${clientId}:${windowId}`, WINDOW_SECONDS);
  if (count === null) return null;
  if (count > limit) return exceeded(limit);
  return { success: true, remaining: Math.max(0, limit - count) };
}

export async function rateLimiter(
  request: NextRequest,
  userId?: string
): Promise<RateLimitResult> {
  // Key on the authenticated principal (user id) when there is one; otherwise
  // (operator key) on the caller's network address. Namespaced so a user id
  // can never collide with an IP string.
  // Key on the authenticated principal when there is one. Operator-key callers
  // are keyed per source address only when the proxy headers can be trusted
  // (Vercel, or an explicit opt-in); otherwise they share one bucket, because a
  // spoofable header must not hand every caller a fresh budget.
  const ip = trustProxyHeaders()
    ? validIp(request.headers.get('x-real-ip')) ?? validIp(request.headers.get('x-forwarded-for'))
    : undefined;
  const clientId = userId ? `user:${userId}` : ip ? `ip:${ip}` : 'operator';

  const tier = process.env.MCP_RATE_LIMIT_TIER || 'default';
  const limits = RATE_LIMITS[tier as keyof typeof RATE_LIMITS] || RATE_LIMITS.default;
  const limit = limits.requestsPerMinute;

  const now = Date.now();

  if (sharedStoreEnabled()) {
    const shared = await limitShared(clientId, limit, now);
    if (shared) return shared;
    // null: store unavailable for this request; degrade to the local window.
  }

  return limitLocally(clientId, limit, now);
}
