import { NextRequest } from 'next/server';
import { trustProxyHeaders, validIp } from '@/lib/oauth/config';
import { decrementWindow, incrementWindow, sharedStoreEnabled, warnIfNoSharedStore } from '@/lib/shared-store';

/**
 * Rate limiter (M8 / SPLIT-254; distributed variant; SPLIT-1449 tool-call budget).
 *
 * TWO BUDGETS, both per principal per minute, same tier table:
 *
 *  - `requestsPerMinute`  bounds HTTP requests          → rateLimiter()
 *  - `toolCallsPerMinute` bounds tool INVOCATIONS       → toolCallRateLimiter()
 *
 * SPLIT-1449: `toolCallsPerMinute` used to be declared here and enforced
 * nowhere, which was worse than having no second limit at all — it read as a
 * control, so nobody added one. Two facts made it load-bearing:
 *
 *  1. A single JSON-RPC POST may carry a BATCH of messages, and the transport
 *     dispatches every member of it (webStandardStreamableHttp handlePostRequest).
 *  2. Each `tools/call` fans out to at least one backend REST call.
 *
 * So the request budget bounded HTTP traffic but not the backend work behind
 * it: N invocations in one POST cost exactly 1 unit. The tool-call budget is
 * charged per invocation, counting batch members individually. Counting needs
 * the parsed body, so the charge is applied by the route handler
 * (src/app/api/mcp/route.ts) — it parses once and hands the value to the
 * transport, which never reads the (single-use) body stream itself.
 *
 * TWO LAYERS, same accounting (`consume*` below), same result shape:
 *
 * 1. SHARED STORE (Upstash Redis REST via `@/lib/shared-store`), used whenever
 *    it is configured. Fixed one-minute window keyed on budget + principal:
 *    `mcp:rl:<budget>:<clientId>:<floor(now / 60s)>`, one INCRBY per charge
 *    with the key expiring after the window. This is the true GLOBAL limit
 *    across every serverless instance.
 * 2. IN-MEMORY FALLBACK, used when no store is configured or the store is
 *    unavailable for a given request (the store module resolves `null` instead
 *    of throwing, so a Redis outage degrades to the best-effort limiter rather
 *    than failing every MCP call). It is PER INSTANCE: on Vercel each
 *    concurrent lambda has its own map, so it is defense-in-depth on top of the
 *    mandatory auth (operator API key, OAuth token or verified backend JWT; see
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

/**
 * Both budgets share one store, so their keys carry an explicit budget prefix
 * on top of the principal prefix from resolveClientId. Relying on `user:`/`ip:`
 * never colliding with a tool-call key would work today but only by accident —
 * the same accident that was bypass #3 in resolveClientId's history.
 */
type Budget = 'req' | 'tools';

const WINDOW_MS = 60 * 1000;
const WINDOW_SECONDS = WINDOW_MS / 1000;
const MAX_ENTRIES = 10_000; // guardrail against unbounded growth
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

function sweep(now: number): void {
  for (const [key, value] of rateLimitStore.entries()) {
    if (now > value.resetTime) rateLimitStore.delete(key);
  }
}

function limitsForTier() {
  const tier = process.env.MCP_RATE_LIMIT_TIER || 'default';
  return RATE_LIMITS[tier as keyof typeof RATE_LIMITS] || RATE_LIMITS.default;
}

/**
 * Resolve the principal a bucket belongs to. The original derivation
 * (`userId || request.ip || x-forwarded-for || 'anonymous'`) was bypassable
 * three ways, and each is closed here:
 *
 *  1. `x-forwarded-for` is CLIENT-SUPPLIED and the whole raw chain was used
 *     verbatim, so rotating it minted a fresh bucket per request. Proxy
 *     headers are believed only where a trusted proxy sets them (Vercel, or an
 *     explicit `MCP_TRUST_PROXY_HEADERS=1`), the platform-set
 *     `x-vercel-forwarded-for` is preferred, and of a chain only the LAST hop
 *     — the entry the proxy appended — may key the bucket (`validIp`).
 *     Anywhere else every operator-key caller shares ONE bucket, because a
 *     spoofable header must not hand each caller a fresh budget.
 *  2. `userId` came from an UNVERIFIED JWT payload, so rotating `sub` minted
 *     buckets just as freely. Fixed at the source: middleware/auth.ts takes
 *     the principal from a verified identity (SPLIT-1438).
 *  3. The key spaces were not namespaced, so a caller could choose an id that
 *     collided with another caller's IP key and exhaust their budget.
 *     Prefixing by principal type keeps them structurally disjoint.
 *
 * `NextRequest.ip` was dropped in Next 15 — it only survived here behind a cast
 * that made a dead branch look live — so the headers are read explicitly.
 */
function resolveClientId(request: NextRequest, userId?: string): string {
  if (userId) return `user:${userId}`;
  if (trustProxyHeaders()) {
    const ip =
      validIp(request.headers.get('x-vercel-forwarded-for')) ??
      validIp(request.headers.get('x-real-ip')) ??
      validIp(request.headers.get('x-forwarded-for'));
    if (ip) return `ip:${ip}`;
  }
  // No attributable network identity: one shared bucket. Deny-by-default auth
  // runs BEFORE this, so reaching here means an authenticated operator-key
  // caller, never the open internet.
  return 'operator';
}

function bucketKey(budget: Budget, clientId: string): string {
  return `${budget}:${clientId}`;
}

/**
 * Charge `cost` units against one in-memory bucket (the fallback layer).
 *
 * All-or-nothing: a charge that would overrun the window is refused WITHOUT
 * consuming anything, so an oversized batch cannot drain the budget it was
 * refused from (which would let one rejected request deny the whole minute).
 * A consequence worth stating plainly: a single batch larger than the entire
 * per-minute allowance can never succeed — it is refused on a fresh window too,
 * which is the honest reading of "at most N tool calls per minute".
 */
function consumeLocally(key: string, limit: number, cost: number, now: number): RateLimitResult {
  // Bounded inline cleanup (replaces the leaking setInterval): only sweep when
  // the map has grown, keeping per-call cost ~O(1) in the common case.
  if (rateLimitStore.size > MAX_ENTRIES) sweep(now);

  const clientData = rateLimitStore.get(key);

  if (!clientData || now > clientData.resetTime) {
    if (cost > limit) return { success: false, remaining: limit };
    rateLimitStore.set(key, { count: cost, resetTime: now + WINDOW_MS });
    return { success: true, remaining: limit - cost };
  }

  if (clientData.count + cost > limit) {
    return { success: false, remaining: Math.max(0, limit - clientData.count) };
  }

  clientData.count += cost;
  return { success: true, remaining: limit - clientData.count };
}

/**
 * Charge `cost` units against one shared fixed window (the distributed layer).
 * Resolves `null` when the store is unavailable so the caller can fall back to
 * the per-instance bucket for this request only.
 *
 * INCRBY is atomic at the server, so "increment, then look at the number I got
 * back" is a race-free check-and-consume. All-or-nothing is kept by handing a
 * refused multi-unit charge back (DECRBY): a refused batch must not drain the
 * window it was refused from. A refused single unit is left as is — once a
 * window is at its ceiling every later charge is over it regardless of the
 * exact count, and the refund would only add a round-trip per refused request
 * during a flood.
 */
async function consumeShared(key: string, limit: number, cost: number, now: number): Promise<RateLimitResult | null> {
  const windowKey = `rl:${key}:${Math.floor(now / WINDOW_MS)}`;
  const count = await incrementWindow(windowKey, WINDOW_SECONDS, cost);
  if (count === null) return null;
  if (count > limit) {
    const before = count - cost;
    if (cost > 1) await decrementWindow(windowKey, WINDOW_SECONDS, cost);
    return { success: false, remaining: Math.max(0, limit - before) };
  }
  return { success: true, remaining: Math.max(0, limit - count) };
}

/** One charge against one budget: the shared window when a store is configured and answers, else the local bucket. */
async function charge(budget: Budget, request: NextRequest, userId: string | undefined, limit: number, cost: number): Promise<RateLimitResult> {
  // Once per cold instance, say out loud that this limiter is per-instance.
  warnIfNoSharedStore();
  const key = bucketKey(budget, resolveClientId(request, userId));
  const now = Date.now();

  if (sharedStoreEnabled()) {
    const shared = await consumeShared(key, limit, cost, now);
    if (shared) return shared;
    // null: store unavailable for this request; degrade to the local window.
  }

  return consumeLocally(key, limit, cost, now);
}

export async function rateLimiter(
  request: NextRequest,
  userId?: string
): Promise<RateLimitResult> {
  const limits = limitsForTier();
  const result = await charge('req', request, userId, limits.requestsPerMinute, 1);

  if (result.success) return result;
  return {
    ...result,
    error: `Rate limit exceeded. Maximum ${limits.requestsPerMinute} requests per minute.`,
  };
}

/**
 * Count what a JSON-RPC payload actually costs in tool invocations: every
 * `tools/call` message, whether the body is a single message or a batch array.
 * Anything else (initialize, tools/list, notifications, malformed members)
 * costs nothing — those are bounded by the per-request budget alone.
 *
 * Deliberately shape-based rather than schema-based: the transport validates
 * the messages, this only has to price them, and a member it cannot recognise
 * must not be able to make the count throw.
 */
export function countToolCalls(body: unknown): number {
  const messages = Array.isArray(body) ? body : [body];
  return messages.filter(isToolCall).length;
}

function isToolCall(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    'method' in message &&
    message.method === 'tools/call'
  );
}

/**
 * Charge the tool-call budget for one request. `toolCalls` is the count from
 * countToolCalls(); zero costs nothing and touches no state, so non-tool
 * traffic (initialize, tools/list) is unaffected.
 *
 * Keyed by the same principal as the request budget — a caller who cannot
 * rotate one bucket cannot rotate the other — but in its own key space, so
 * neither budget can exhaust the other.
 */
export async function toolCallRateLimiter(
  request: NextRequest,
  toolCalls: number,
  userId?: string
): Promise<RateLimitResult> {
  if (toolCalls <= 0) return { success: true };

  const limits = limitsForTier();
  const result = await charge('tools', request, userId, limits.toolCallsPerMinute, toolCalls);

  if (result.success) return result;
  return {
    ...result,
    error: `Rate limit exceeded. Maximum ${limits.toolCallsPerMinute} tool calls per minute (this request asked for ${toolCalls}).`,
  };
}
