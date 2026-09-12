import { NextRequest } from 'next/server';

/**
 * Rate limiter (M8 / SPLIT-254).
 *
 * IMPORTANT: this is a BEST-EFFORT, PER-INSTANCE limiter. On Vercel each
 * concurrent lambda has its own in-memory store, so this does not enforce a
 * true global limit — it is defense-in-depth on top of the mandatory auth
 * (operator API key or backend JWT bearer; see middleware/auth.ts). A true
 * distributed limit needs a shared store (Upstash Redis); tracked as a
 * follow-up. The previous implementation also leaked a module-level
 * setInterval (a dangling timer/handle per cold start) and imported Supabase
 * it never used — both removed here. Stale entries are reclaimed lazily via a
 * bounded inline sweep when the map grows, so there is no timer.
 */

/**
 * `toolCallsPerMinute` is DECLARED but not enforced by this limiter, which
 * counts HTTP requests — and one JSON-RPC POST may carry a batch of tool calls.
 * Enforcing it needs the request body, i.e. the route handler, not this
 * middleware; left as a follow-up rather than silently implied.
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
const MAX_ENTRIES = 10_000; // guardrail against unbounded growth
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

function sweep(now: number): void {
  for (const [key, value] of rateLimitStore.entries()) {
    if (now > value.resetTime) rateLimitStore.delete(key);
  }
}

/**
 * Resolve the bucket key. The previous derivation
 * (`userId || request.ip || x-forwarded-for || 'anonymous'`) was bypassable
 * three ways:
 *
 *  1. `x-forwarded-for` is a CLIENT-SUPPLIED header and the whole raw chain was
 *     used verbatim, so rotating it (`1.1.1.1`, then `2.2.2.2`, …) minted a
 *     fresh bucket on every request. Prefer the platform-set header, and
 *     otherwise take the LAST hop of the chain — the entry the trusted proxy
 *     appended, not anything the client wrote ahead of it.
 *  2. `userId` came from an UNVERIFIED JWT payload, so rotating `sub` minted
 *     buckets just as freely. Fixed at the source: middleware/auth.ts now takes
 *     the principal from a verified identity (lib/jwt.ts).
 *  3. The two key spaces were not namespaced, so a caller could choose an id
 *     that collided with another caller's IP key and exhaust their budget.
 *     Prefixing by principal type keeps them structurally disjoint.
 *
 * `NextRequest.ip` was dropped in Next 15 — it only survived here behind a cast
 * that made a dead branch look live — so read the headers explicitly.
 */
function resolveClientId(request: NextRequest, userId?: string): string {
  if (userId) return `user:${userId}`;

  // Set by the Vercel edge on every inbound request; a client cannot supply it.
  const platformIp = request.headers.get('x-vercel-forwarded-for');
  if (platformIp) return `ip:${platformIp.trim()}`;

  const chain = request.headers.get('x-forwarded-for');
  if (chain) {
    const hops = chain.split(',').map((hop) => hop.trim()).filter(Boolean);
    const closest = hops[hops.length - 1];
    if (closest) return `ip:${closest}`;
  }

  const realIp = request.headers.get('x-real-ip');
  if (realIp) return `ip:${realIp.trim()}`;

  // No usable network identity: one shared bucket. Deny-by-default auth runs
  // BEFORE this, so reaching here means an authenticated operator-key caller
  // behind an unknown proxy, never the open internet.
  return 'ip:unknown';
}

export async function rateLimiter(
  request: NextRequest,
  userId?: string
): Promise<RateLimitResult> {
  const clientId = resolveClientId(request, userId);

  const tier = process.env.MCP_RATE_LIMIT_TIER || 'default';
  const limits = RATE_LIMITS[tier as keyof typeof RATE_LIMITS] || RATE_LIMITS.default;

  const now = Date.now();
  // Bounded inline cleanup (replaces the leaking setInterval): only sweep when
  // the map has grown, keeping per-call cost ~O(1) in the common case.
  if (rateLimitStore.size > MAX_ENTRIES) sweep(now);

  const clientData = rateLimitStore.get(clientId);

  if (!clientData || now > clientData.resetTime) {
    rateLimitStore.set(clientId, { count: 1, resetTime: now + WINDOW_MS });
    return { success: true, remaining: limits.requestsPerMinute - 1 };
  }

  if (clientData.count >= limits.requestsPerMinute) {
    return {
      success: false,
      error: `Rate limit exceeded. Maximum ${limits.requestsPerMinute} requests per minute.`,
      remaining: 0,
    };
  }

  clientData.count++;
  return {
    success: true,
    remaining: limits.requestsPerMinute - clientData.count,
  };
}
