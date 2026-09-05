/**
 * Per-key FAILURE throttle for the hosted sign-in pages (password form, OTP
 * step, social callback). Two layers behind one async API, both counting
 * failed attempts only (a check reads the counter; `recordAttempt` is called on
 * failure, never on success), so a legitimate owner is never locked out by
 * other people's successful logins from a shared address, and nothing is
 * cleared on success:
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
 * Either way the backend's own per-IP / per-email login throttle is the real
 * control: it is fed the end-user IP via the trusted relay headers.
 */
import { getCount, incrementWindow, sharedStoreEnabled } from '@/lib/shared-store';

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

function recordLocally(key: string, now: number): void {
  if (attempts.size > MAX_KEYS) {
    for (const [k, v] of attempts) if (now > v.resetAt) attempts.delete(k);
  }
  const entry = attempts.get(key);
  if (!entry || now > entry.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  entry.count += 1;
}

/** Has `key` accumulated too many FAILURES in the current window? (read-only) */
export async function isThrottled(key: string, now = Date.now()): Promise<boolean> {
  if (sharedStoreEnabled()) {
    const count = await getCount(sharedKey(key, now));
    if (count !== null) return count >= MAX_ATTEMPTS;
  }
  return locallyThrottled(key, now);
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
