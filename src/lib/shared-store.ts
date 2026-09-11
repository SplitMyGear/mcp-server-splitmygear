/**
 * Shared store for cross-instance state (Upstash Redis over its REST API).
 *
 * On Vercel every concurrent lambda has its own memory, so anything that must
 * be counted or remembered ACROSS instances (the MCP rate limit, the hosted
 * login throttle, the authorization-code replay cache) needs a shared store.
 * This module is that store, with three deliberate constraints:
 *
 * - Zero npm dependencies: Upstash exposes Redis over plain HTTPS/JSON
 *   (`POST <url>` with `["CMD", ...args]`, `POST <url>/pipeline` with an array
 *   of commands). Vercel KV is Upstash-backed and speaks the same protocol, so
 *   its `KV_REST_API_URL` / `KV_REST_API_TOKEN` names are accepted as well.
 * - FAILS OPEN, never throws: every primitive resolves to `null` when the store
 *   is not configured, unreachable, slow (1.5 s budget), rejects the request
 *   or answers with an unexpected shape. `null` means "store unavailable, use
 *   the local (per-instance) fallback": callers keep their in-memory logic and
 *   treat this module as an upgrade, not a hard dependency. A store outage is
 *   reported through `console.warn` at most once per minute per instance so a
 *   flapping store cannot flood the logs.
 * - Every key is namespaced under `mcp:` (added here when missing) so the MCP
 *   can share a Redis database with other services without collisions. Keys
 *   are never logged: they may embed user ids or IPs.
 *
 * Primitives (all return `null` when the store is unavailable):
 * - `incrementWindow(key, windowSeconds)`: fixed-window counter. INCR plus
 *   EXPIRE-if-no-ttl in one pipeline; returns the count after this hit. INCR is
 *   ATOMIC at the server, which is what lets a caller use "increment, then look
 *   at the number I got back" as a race-free check-and-consume (see
 *   `oauth/throttle`); a GET followed by a later INCR is NOT race-free.
 * - `decrementWindow(key, windowSeconds)`: the inverse, for giving back a slot
 *   claimed by `incrementWindow` that turned out not to count.
 * - `setIfAbsent(key, ttlSeconds)`: SET ... EX ttl NX; true when this call
 *   created the key, false when it already existed.
 * - `redeemOnce(key, ttlSeconds)`: `setIfAbsent` under a name that reads well
 *   for one-time tokens (authorization codes): true the first time, false on a
 *   replay.
 *
 * WITHOUT a store every one of these resolves `null` and the callers fall back
 * to per-instance memory, which on Vercel means "per concurrent lambda" — i.e.
 * near-useless against an attacker who simply opens several connections. That
 * degradation is deliberate but must never be SILENT: `warnIfNoSharedStore()`
 * names the affected protections once per instance, and an operator who wants
 * the strict posture instead sets `MCP_REQUIRE_SHARED_STORE=1` (see
 * `sharedStoreRequired`, consumed by `oauth/config.oauthEnabled`).
 */

const KEY_PREFIX = 'mcp:';
const REQUEST_TIMEOUT_MS = 1_500;
const WARN_INTERVAL_MS = 60_000;

type RedisArg = string | number;
type RedisCommand = RedisArg[];

/** One entry of an Upstash response: `{ result }` on success, `{ error }` per failed command. */
interface RedisReply {
  result?: unknown;
  error?: string;
}

interface StoreConfig {
  url: string;
  token: string;
}

let lastWarnAt = 0;
let degradationWarned = false;

/**
 * Resolve the store credentials from the environment, read on every call so a
 * test (or a runtime secret rotation) never has to reload the module. Upstash
 * names win; the Vercel KV pair is the fallback. A half-configured pair (URL
 * without token or vice versa) counts as "not configured".
 */
function storeConfig(): StoreConfig | null {
  const pairs: Array<[string | undefined, string | undefined]> = [
    [process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN],
    [process.env.KV_REST_API_URL, process.env.KV_REST_API_TOKEN],
  ];
  for (const [url, token] of pairs) {
    if (url && token) return { url: url.replace(/\/+$/, ''), token };
  }
  return null;
}

/** True when a shared store is configured (credentials present), regardless of reachability. */
export function sharedStoreEnabled(): boolean {
  return storeConfig() !== null;
}

/**
 * The protections that silently become per-instance (and therefore per
 * concurrent lambda) when no shared store is configured. Listed by name so the
 * startup warning below tells an operator exactly what they are running
 * without, rather than a vague "degraded" line.
 */
const DEGRADED_WITHOUT_STORE = [
  'the per-principal MCP rate limit',
  'the hosted sign-in failure throttle',
  'the authorization-code single-use (replay) cache',
];

/**
 * Whether the operator has demanded a shared store as a hard precondition
 * (`MCP_REQUIRE_SHARED_STORE=1`). Default OFF: see `warnIfNoSharedStore` for
 * why the degraded mode is allowed to run at all.
 */
export function sharedStoreRequired(): boolean {
  return process.env.MCP_REQUIRE_SHARED_STORE === '1';
}

/**
 * Say ONCE per instance, loudly, that the cross-instance protections are not
 * actually cross-instance. Called from each degraded path (rate limiter,
 * sign-in throttle, code replay cache), so on serverless it lands on the first
 * request a cold instance serves — the closest thing to "startup" there is.
 *
 * Why this is a warning and not a refusal by default: the shared store is a
 * paid dependency, and failing closed on it would take the ONLY user-facing
 * sign-in path offline entirely. The Splitt backend remains the authoritative
 * throttle (it is fed the real client IP via `MCP_BFF_RELAY_KEY`) and PKCE S256
 * — mandatory here — already binds an authorization code to its requester, so
 * the degraded layer is defence-in-depth that is thinner, not absent. An
 * operator who prefers the strict posture flips `MCP_REQUIRE_SHARED_STORE=1`
 * and OAuth then refuses to enable at all.
 */
export function warnIfNoSharedStore(): void {
  if (degradationWarned || sharedStoreEnabled()) return;
  degradationWarned = true;
  console.warn(
    '[shared-store] NO SHARED STORE CONFIGURED (UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN, ' +
      'or the Vercel KV equivalents). These protections are per-instance only and a distributed ' +
      `attacker can outrun them: ${DEGRADED_WITHOUT_STORE.join(', ')}. ` +
      'Configure the store, or set MCP_REQUIRE_SHARED_STORE=1 to refuse to serve OAuth without one.',
  );
}

/** Namespace a key under `mcp:` exactly once (a caller passing the full key is left alone). */
export function namespacedKey(key: string): string {
  return key.startsWith(KEY_PREFIX) ? key : `${KEY_PREFIX}${key}`;
}

/** Clamp a TTL to a positive whole number of seconds (Redis rejects 0 and fractions). */
function ttlSeconds(seconds: number): number {
  return Math.max(1, Math.ceil(Number.isFinite(seconds) ? seconds : 1));
}

/**
 * Log a store outage without flooding: at most one line per minute per
 * instance. Only the operation and the failure class are logged, never a key,
 * a token or a response body.
 */
function warnUnavailable(operation: string, reason: unknown): void {
  const now = Date.now();
  if (now - lastWarnAt < WARN_INTERVAL_MS) return;
  lastWarnAt = now;
  const detail = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
  console.warn(`[shared-store] unavailable during ${operation} (${detail}); using the per-instance fallback`);
}

/**
 * POST a JSON body to the Upstash REST endpoint and return the parsed reply,
 * or `null` on any failure (timeout, network error, non-2xx, non-JSON body).
 */
async function post(cfg: StoreConfig, path: string, body: unknown, operation: string): Promise<unknown | null> {
  let response: Response;
  try {
    response = await fetch(`${cfg.url}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // Bounded so a slow store can never stall an MCP request: past this the
      // caller falls back to its per-instance logic.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    warnUnavailable(operation, err);
    return null;
  }

  if (!response.ok) {
    warnUnavailable(operation, `HTTP ${response.status}`);
    return null;
  }

  try {
    const raw = await response.text();
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    warnUnavailable(operation, err);
    return null;
  }
}

/** Run one command; `null` when the store is unavailable or the command errored. */
async function execute(cfg: StoreConfig, command: RedisCommand, operation: string): Promise<RedisReply | null> {
  const parsed = await post(cfg, '', command, operation);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    if (parsed !== null) warnUnavailable(operation, 'unexpected response shape');
    return null;
  }
  return parsed as RedisReply;
}

/** Run several commands in one round trip; `null` unless one reply per command came back. */
async function pipeline(cfg: StoreConfig, commands: RedisCommand[], operation: string): Promise<RedisReply[] | null> {
  const parsed = await post(cfg, '/pipeline', commands, operation);
  if (!Array.isArray(parsed) || parsed.length !== commands.length) {
    if (parsed !== null) warnUnavailable(operation, 'unexpected pipeline response shape');
    return null;
  }
  return parsed as RedisReply[];
}

/** Upstash returns integers as JSON numbers; tolerate a numeric string too. */
function asCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

/**
 * Increment a fixed-window counter and return the count after this hit.
 *
 * Pipeline: `INCR key` then `EXPIRE key ttl NX` (set the TTL only when the key
 * has none, so the window never slides). Servers older than Redis 7 reject the
 * `NX` flag; when that happens and this call created the key (count is 1) a
 * plain `EXPIRE` is issued so the key still expires. `null` means the store is
 * unavailable: use the local fallback for this request.
 */
export function incrementWindow(key: string, windowSeconds: number): Promise<number | null> {
  return stepWindow('INCR', key, windowSeconds);
}

/**
 * Decrement a fixed-window counter and return the count after this hit — the
 * inverse of `incrementWindow`, used to hand back a slot that was claimed
 * optimistically and turned out not to be spent (a sign-in attempt that
 * SUCCEEDED does not count against a failure budget).
 *
 * Always paired with a preceding `incrementWindow` on the SAME key, so the
 * counter cannot be driven below zero by normal use. `EXPIRE ... NX` rides
 * along for the pathological case where the window key expired in between:
 * DECR would otherwise resurrect it at -1 with no TTL and leave it there.
 */
export function decrementWindow(key: string, windowSeconds: number): Promise<number | null> {
  return stepWindow('DECR', key, windowSeconds);
}

/** INCR/DECR plus EXPIRE-if-no-ttl in one round trip; `null` when the store is unavailable. */
async function stepWindow(command: 'INCR' | 'DECR', key: string, windowSeconds: number): Promise<number | null> {
  const cfg = storeConfig();
  if (!cfg) return null;

  const fullKey = namespacedKey(key);
  const ttl = ttlSeconds(windowSeconds);
  const replies = await pipeline(cfg, [[command, fullKey], ['EXPIRE', fullKey, ttl, 'NX']], command);
  if (!replies) return null;

  const [step, expire] = replies;
  if (step.error !== undefined) {
    warnUnavailable(command, step.error);
    return null;
  }
  const count = asCount(step.result);
  if (count === null) {
    warnUnavailable(command, `non-numeric ${command} result`);
    return null;
  }

  if (expire.error !== undefined && (count === 1 || count <= 0)) {
    // The counter exists without a TTL: fall back to a plain EXPIRE so the
    // window still closes. Only when this call created the key (INCR to 1, or
    // a DECR that resurrected it), otherwise every request would push the
    // expiry out again. Its outcome does not change the count.
    await execute(cfg, ['EXPIRE', fullKey, ttl], 'EXPIRE');
  }

  return count;
}

/**
 * Create `key` with a TTL only if it does not exist (`SET key 1 EX ttl NX`).
 * Returns true when this call created the key, false when it already existed,
 * `null` when the store is unavailable (use the local fallback).
 */
/**
 * Read a counter without touching it (`GET key`). Returns 0 for a missing key,
 * `null` when the store is unavailable. Lets callers separate "check" from
 * "record" so a throttle can count failures only.
 */
export async function getCount(key: string): Promise<number | null> {
  const cfg = storeConfig();
  if (!cfg) return null;
  const reply = await execute(cfg, ['GET', namespacedKey(key)], 'getCount');
  if (!reply) return null;
  if ('error' in reply && reply.error) {
    warnUnavailable('getCount', reply.error);
    return null;
  }
  if (reply.result === null || reply.result === undefined) return 0;
  const count = asCount(reply.result);
  if (count === null) {
    warnUnavailable('getCount', 'non-numeric reply');
    return null;
  }
  return count;
}

export async function setIfAbsent(key: string, ttlSecondsWanted: number): Promise<boolean | null> {
  const cfg = storeConfig();
  if (!cfg) return null;

  const reply = await execute(cfg, ['SET', namespacedKey(key), '1', 'EX', ttlSeconds(ttlSecondsWanted), 'NX'], 'SET NX');
  if (!reply) return null;
  if (reply.error !== undefined) {
    warnUnavailable('SET NX', reply.error);
    return null;
  }
  // Redis answers OK when the key was set and a nil reply when NX declined.
  return reply.result === 'OK';
}

/**
 * Redeem a one-time value (an authorization code, a nonce): true the first
 * time `key` is seen within `ttlSeconds`, false on a replay, `null` when the
 * store is unavailable (the caller keeps its per-instance replay cache).
 */
export function redeemOnce(key: string, ttlSecondsWanted: number): Promise<boolean | null> {
  return setIfAbsent(key, ttlSecondsWanted);
}

/** Test hook: forget both warn throttles so each test observes the first warning. */
export function _resetSharedStoreForTests(): void {
  lastWarnAt = 0;
  degradationWarned = false;
}
