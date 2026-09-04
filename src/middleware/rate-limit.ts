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

export async function rateLimiter(
  request: NextRequest,
  userId?: string
): Promise<RateLimitResult> {
  // Key on the authenticated principal (user id) when there is one; otherwise
  // (operator key) on the caller's network address. Namespaced so a user id
  // can never collide with an IP string.
  const ip =
    request.headers.get('x-real-ip') ||
    (request as unknown as { ip?: string }).ip ||
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    'anonymous';
  const clientId = userId ? `user:${userId}` : `ip:${ip}`;

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
