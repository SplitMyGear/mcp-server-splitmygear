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
 * Two budgets, both per client per minute:
 *
 *  - `requestsPerMinute` bounds HTTP requests          → rateLimiter()
 *  - `toolCallsPerMinute` bounds tool INVOCATIONS      → toolCallRateLimiter()
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
 * now charged per invocation, counting batch members individually. Counting
 * needs the parsed body, so the charge is applied by the route handler
 * (src/app/api/mcp/route.ts) — it parses once and hands the value to the
 * transport, which never reads the (single-use) body stream itself.
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

/**
 * Both budgets share one store, so their keys carry an explicit budget prefix
 * on top of the principal prefix from resolveClientId. Relying on `user:`/`ip:`
 * never colliding with a tool-call key would work today but only by accident —
 * the same accident that was bypass #3 above.
 */
function bucketKey(budget: 'req' | 'tools', clientId: string): string {
  return `${budget}|${clientId}`;
}

/**
 * Charge `cost` units against one bucket. Shared by both budgets so the window,
 * sweep and accounting exist once.
 *
 * All-or-nothing: a charge that would overrun the window is refused WITHOUT
 * consuming anything, so an oversized batch cannot drain the budget it was
 * refused from (which would let one rejected request deny the whole minute).
 * A consequence worth stating plainly: a single batch larger than the entire
 * per-minute allowance can never succeed — it is refused on a fresh window too,
 * which is the honest reading of "at most N tool calls per minute".
 */
function consume(key: string, limit: number, cost: number): RateLimitResult {
  const now = Date.now();
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

function limitsForTier() {
  const tier = process.env.MCP_RATE_LIMIT_TIER || 'default';
  return RATE_LIMITS[tier as keyof typeof RATE_LIMITS] || RATE_LIMITS.default;
}

export async function rateLimiter(
  request: NextRequest,
  userId?: string
): Promise<RateLimitResult> {
  const limits = limitsForTier();
  const result = consume(
    bucketKey('req', resolveClientId(request, userId)),
    limits.requestsPerMinute,
    1
  );

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
 * countToolCalls(); zero costs nothing and touches no state, so GETs and
 * non-tool traffic (initialize, tools/list) are unaffected.
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
  const result = consume(
    bucketKey('tools', resolveClientId(request, userId)),
    limits.toolCallsPerMinute,
    toolCalls
  );

  if (result.success) return result;
  return {
    ...result,
    error: `Rate limit exceeded. Maximum ${limits.toolCallsPerMinute} tool calls per minute (this request asked for ${toolCalls}).`,
  };
}
