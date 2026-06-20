import { NextRequest } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * Rate limiter (M8 / SPLIT-254, made durable in SPLIT-373).
 *
 * The previous implementation kept counters in a module-level `Map`. On Vercel
 * every concurrent lambda (and every cold start) has its own memory, so that
 * map enforced no real global limit — it was the ONLY abuse guard in front of
 * the AI-cost `generate_*` tools, yet effectively a no-op across instances.
 *
 * This version uses a DURABLE shared store: a single Postgres statement
 * (`mcp_rate_limit_hit`, applied via Supabase migration `split373_mcp_rate_limit`)
 * atomically upserts-and-increments a per-(clientId, fixed-window) counter and
 * returns the new count, so concurrent lambdas race-safely share one tally.
 * Window expiry is intrinsic (the window start is derived from request time, so
 * a new window starts a fresh row) — there is NO module-level `setInterval`;
 * expired rows are reclaimed by `expiresAt` range scans (an operator cron or a
 * lazy sweep), never by a dangling timer.
 *
 * FAIL-OPEN: any store error (missing env, network, RPC failure) allows the
 * request and logs an ERROR-level marker `mcp.ratelimit.fail_open` so a store
 * outage degrades to "no rate limit" rather than blocking every tool. This
 * mirrors the SPLIT-358 fail-open-with-marker pattern. Auth (operator key or
 * backend JWT, see middleware/auth.ts) remains the mandatory gate either way.
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

/** ERROR-level log marker grepped in prod logs to detect store outages. */
export const FAIL_OPEN_MARKER = 'mcp.ratelimit.fail_open';

/**
 * Lazily-built, module-scoped service-role Supabase client. Built once per
 * lambda the first time the limiter runs (not at import time, so a missing env
 * never crashes cold start). Returns null when the durable store is not
 * configured — the caller then fails open. The service role bypasses RLS, so
 * it can call the locked-down `mcp_rate_limit_hit` function.
 *
 * Exported as a resettable factory hook purely so unit tests can inject a mock
 * client without reaching into module internals.
 */
let cachedClient: SupabaseClient | null | undefined;

export function __setRateLimitClientForTests(
  client: SupabaseClient | null | undefined
): void {
  cachedClient = client;
}

function getClient(): SupabaseClient | null {
  if (cachedClient !== undefined) return cachedClient;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    cachedClient = null;
    return cachedClient;
  }

  cachedClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedClient;
}

export async function rateLimiter(
  request: NextRequest,
  userId?: string
): Promise<RateLimitResult> {
  const clientId =
    userId ||
    (request as unknown as { ip?: string }).ip ||
    request.headers.get('x-forwarded-for') ||
    'anonymous';

  const tier = process.env.MCP_RATE_LIMIT_TIER || 'default';
  const limits =
    RATE_LIMITS[tier as keyof typeof RATE_LIMITS] || RATE_LIMITS.default;

  const client = getClient();
  if (!client) {
    // Durable store not configured — fail open (never block) and surface a
    // marker so the misconfiguration is visible in logs.
    console.error(
      `${FAIL_OPEN_MARKER} reason=store_not_configured clientId=${clientId}`
    );
    return { success: true, remaining: limits.requestsPerMinute };
  }

  try {
    const { data, error } = await client.rpc('mcp_rate_limit_hit', {
      p_client_id: clientId,
      p_window_ms: WINDOW_MS,
    });

    if (error) throw error;

    // The RPC returns the NEW count for the current window as an integer.
    const count = Number(data);
    if (!Number.isFinite(count)) {
      throw new Error(`unexpected rpc result: ${JSON.stringify(data)}`);
    }

    if (count > limits.requestsPerMinute) {
      return {
        success: false,
        error: `Rate limit exceeded. Maximum ${limits.requestsPerMinute} requests per minute.`,
        remaining: 0,
      };
    }

    return {
      success: true,
      remaining: Math.max(0, limits.requestsPerMinute - count),
    };
  } catch (err) {
    // Any store error => fail open with an ERROR-level marker (SPLIT-358
    // pattern). A rate-limiter outage must never take the tools down.
    console.error(
      `${FAIL_OPEN_MARKER} reason=store_error clientId=${clientId} error=${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return { success: true, remaining: limits.requestsPerMinute };
  }
}
