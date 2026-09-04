/**
 * Best-effort per-key attempt throttle for the hosted login form (per
 * serverless instance; the backend's own per-IP / per-email login throttle is
 * the real control and is fed the end-user IP via the trusted relay headers).
 */
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const MAX_KEYS = 10_000;

const attempts = new Map<string, { count: number; resetAt: number }>();

export function isThrottled(key: string, now = Date.now()): boolean {
  const entry = attempts.get(key);
  if (!entry || now > entry.resetAt) return false;
  return entry.count >= MAX_ATTEMPTS;
}

export function recordAttempt(key: string, now = Date.now()): void {
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

export function clearAttempts(key: string): void {
  attempts.delete(key);
}

/** Test hook. */
export function _resetThrottle(): void {
  attempts.clear();
}
