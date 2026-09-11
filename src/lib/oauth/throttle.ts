/**
 * Per-key FAILURE throttle for the hosted sign-in pages (password form, OTP
 * step, social callback). Two layers behind one async API:
 *
 * 1. SHARED STORE (Upstash Redis REST via `@/lib/shared-store`), used whenever
 *    it is configured: fixed ten-minute window per key,
 *    `mcp:login:<key>:<floor(now / 10 min)>`, expiring with the window. This
 *    is the real cross-instance limit: on Vercel every concurrent lambda has
 *    its own memory, so without it an attacker spreading guesses across
 *    instances would never trip the per-instance map.
 * 2. IN-MEMORY MAP, used when no store is configured or the store is
 *    unavailable for this request (the store module resolves `null` instead of
 *    throwing). Always written too, so a store outage degrades gracefully.
 *
 * CLAIM / REFUND, not check-then-record (SPLIT-1420)
 * --------------------------------------------------
 * The budget is still spent by FAILURES only, but it is consumed ATOMICALLY up
 * front. `claimAttempt` increments the counter and decides on the number the
 * increment itself returned; an attempt that turns out not to be a failure
 * gives the slot back with `refundAttempt`.
 *
 * The obvious shape — read the counter, run the login, increment on failure —
 * cannot hold a ceiling: every request in a concurrent burst reads the same
 * pre-burst value and is waved through, because the read and the increment are
 * separated by a full backend round-trip. Ten simultaneous requests all see
 * "0 so far" and all proceed. Redis INCR is atomic, so claiming first makes the
 * Nth concurrent claimant see N and stop; the local map gets the same property
 * for free (the increment and the test sit in one synchronous block, with no
 * `await` between them for another request to interleave into).
 *
 * Refunding on success is what keeps the failures-only accounting: a correct
 * password holds a slot for the duration of the backend call and then returns
 * it, so a legitimate owner is never locked out by their own successful
 * sign-ins, nor by other people's from a shared address. Nothing else clears
 * the counter — a valid login must not reset the budget for guesses at other
 * accounts.
 *
 * A claim that is never settled (the lambda dies mid-request) simply stays
 * spent for the rest of the window. That is the safe direction to fail.
 *
 * Either way the backend's own per-IP / per-email login throttle is the real
 * control: it is fed the end-user IP via the trusted relay headers.
 */
import { decrementWindow, getCount, incrementWindow, sharedStoreEnabled, warnIfNoSharedStore } from '@/lib/shared-store';

const WINDOW_MS = 10 * 60 * 1000;
const WINDOW_S = WINDOW_MS / 1000;
const MAX_ATTEMPTS = 10;
const MAX_KEYS = 10_000;

const attempts = new Map<string, { count: number; resetAt: number }>();

function sharedKey(key: string, now: number): string {
  return `mcp:login:${key}:${Math.floor(now / WINDOW_MS)}`;
}

function locallyThrottled(key: string, now: number): boolean {
  const entry = attempts.get(key);
  if (!entry || now > entry.resetAt) return false;
  return entry.count >= MAX_ATTEMPTS;
}

/** Increment the per-instance counter and return the count AFTER this hit. */
function recordLocally(key: string, now: number): number {
  if (attempts.size > MAX_KEYS) {
    for (const [k, v] of attempts) if (now > v.resetAt) attempts.delete(k);
  }
  const entry = attempts.get(key);
  if (!entry || now > entry.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return 1;
  }
  entry.count += 1;
  return entry.count;
}

/** Give one per-instance slot back (never below zero, never past the window). */
function refundLocally(key: string, now: number): void {
  const entry = attempts.get(key);
  if (!entry || now > entry.resetAt) return;
  entry.count = Math.max(0, entry.count - 1);
}

/**
 * Has `key` accumulated too many FAILURES in the current window?
 *
 * ADVISORY READ ONLY — never gate a sign-in attempt on this. It is a plain GET,
 * so between it and whatever you do next any number of concurrent requests can
 * read the same value and be waved through. Use `claimAttempt`, which consumes
 * the slot in the same atomic step as the decision. This stays exported for
 * diagnostics and for asserting a counter's state in tests.
 */
export async function isThrottled(key: string, now = Date.now()): Promise<boolean> {
  if (sharedStoreEnabled()) {
    const count = await getCount(sharedKey(key, now));
    if (count !== null) return count >= MAX_ATTEMPTS;
  }
  return locallyThrottled(key, now);
}

/**
 * ATOMICALLY consume one slot of `key`'s failure budget and say whether the
 * attempt may proceed. `false` means the budget was already spent — the
 * caller must not run the attempt.
 *
 * The decision is made on the number the increment ITSELF returned (Redis INCR
 * is atomic; the local map's increment-and-test is one synchronous block), so
 * a concurrent burst is counted 1, 2, 3 … and the ones past the ceiling are
 * refused. There is no window in which two requests can both believe they are
 * under the limit.
 *
 * The slot stays spent unless the caller gives it back with `refundAttempt`.
 *
 * A REFUSED claim still increments — the counter cannot be read without
 * consuming, that is the whole point — so the caller hands it back too (see
 * `beginAttempt` in authorize.ts, which refunds every key of a refused
 * attempt). Being turned away is not a failed guess, and leaving refusals to
 * accumulate would let someone hold a lockout open by hammering it. Even
 * un-refunded it cannot extend one: the window's TTL is set once (`EXPIRE NX`)
 * and never pushed out.
 */
export async function claimAttempt(key: string, now = Date.now()): Promise<boolean> {
  warnIfNoSharedStore();
  // Always claimed locally too, so the per-instance layer keeps a usable
  // history for the requests where the store turns out to be unreachable.
  const localCount = recordLocally(key, now);
  if (sharedStoreEnabled()) {
    const shared = await incrementWindow(sharedKey(key, now), WINDOW_S);
    if (shared !== null) return shared <= MAX_ATTEMPTS;
  }
  return localCount <= MAX_ATTEMPTS;
}

/**
 * Give back a slot taken by `claimAttempt` for an attempt that turned out NOT
 * to be a failure (correct credentials, or a claim abandoned because a
 * different key refused the attempt). Pass the same `now` the claim used, so
 * the refund lands on the same fixed window.
 */
export async function refundAttempt(key: string, now = Date.now()): Promise<void> {
  refundLocally(key, now);
  if (sharedStoreEnabled()) {
    await decrementWindow(sharedKey(key, now), WINDOW_S);
  }
}

/** Record a FAILED attempt against `key` in the shared window (when available) and locally. */
export async function recordAttempt(key: string, now = Date.now()): Promise<void> {
  recordLocally(key, now);
  if (sharedStoreEnabled()) {
    await incrementWindow(sharedKey(key, now), WINDOW_S);
  }
}

export function clearAttempts(key: string): void {
  attempts.delete(key);
}

/** Test hook. */
export function _resetThrottle(): void {
  attempts.clear();
}
