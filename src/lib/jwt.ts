import crypto from 'crypto';
import { backendRequest } from '@/lib/backend-client';

/**
 * Identity verification for SplitMyGear backend JWTs (HS256, `{ sub, email,
 * role }`, issued by POST /api/v1/users/login).
 *
 * Security fix (2026-09-11 review): this module used to DECODE-and-trust
 * whenever `MCP_BACKEND_JWT_SECRET` was absent — which is the DEPLOYED
 * configuration — so any `<header>.<base64 claims>.junk` string with a future
 * `exp` cleared authMiddleware, and the server's advertised "deny-by-default,
 * two ways in" contract was false. Verification is now MANDATORY, via one of
 * two paths, and every failure fails CLOSED:
 *
 *  1. LOCAL (preferred): `MCP_BACKEND_JWT_SECRET` = the backend's `JWT_SECRET`
 *     → verify the HS256 signature in-process. No network hop, so this is
 *     strictly better; it is the recommended deployment (see .env.example).
 *  2. REMOTE (fallback, works with no new env var): ask the backend — already
 *     the single authority this server defers to for auth/RBAC/ownership — who
 *     the caller is, via `GET /users/profile` with the caller's own token. This
 *     mirrors the frontend BFF's `resolveRole()` (pages/api/crm/[...path].ts).
 *     The identity is taken from the BACKEND's response, never from the
 *     client's payload.
 *
 * Rejected: malformed token, expired token, bad signature, non-200 from the
 * backend, an unresolvable user, and an unreachable/slow backend.
 */

/** Role assumed when the verified identity carries none (matches the backend's least-privileged role). */
const DEFAULT_ROLE = 'renter';

/**
 * The identity probe runs BEFORE the tool's own backend call within one 30s
 * function invocation, so it gets a tighter budget than the client's 15s
 * default — two back-to-back full stalls would blow maxDuration and surface as
 * an opaque 500 instead of a clean 401.
 */
const IDENTITY_TIMEOUT_MS = 8_000;

/**
 * Successful REMOTE verifications are cached briefly so a burst of tool calls
 * from one client costs ONE upstream round-trip rather than one per call. Keyed
 * on a SHA-256 of the token — never the raw token, which is a live bearer
 * credential and must not sit in a process-lifetime structure. An entry never
 * outlives the token's own `exp`. Per-instance and best-effort like the rate
 * limiter (middleware/rate-limit.ts): a cold lambda simply re-verifies, and
 * nothing security-relevant depends on a hit.
 */
const VERIFY_CACHE_TTL_MS = 60_000;
const VERIFY_CACHE_MAX_ENTRIES = 1_000;
const verifyCache = new Map<string, { identity: VerifiedIdentity; expiresAt: number }>();

export interface VerifiedIdentity {
  /** The backend's user id — proven by the signature, or resolved by the backend itself. */
  userId: string;
  role: string;
}

/** The only two fields this server reads off the backend's authenticated-profile projection. */
interface BackendProfile {
  id?: unknown;
  role?: unknown;
}

interface DecodedJwt {
  signingInput: string;
  signature: string;
  payload: { sub?: unknown; role?: unknown; exp?: unknown };
}

/**
 * Split and base64url-decode a token. This is a PARSE, not a validation — the
 * result is untrusted until one of the two verification paths blesses it.
 */
function decodeJwt(token: string): DecodedJwt | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const claims = payload as DecodedJwt['payload'];

  return { signingInput: `${parts[0]}.${parts[1]}`, signature: parts[2], payload: claims };
}

function readRole(role: unknown): string {
  return typeof role === 'string' && role ? role : DEFAULT_ROLE;
}

function sweepCache(now: number): void {
  for (const [key, entry] of verifyCache.entries()) {
    if (now >= entry.expiresAt) verifyCache.delete(key);
  }
}

/**
 * Path 1: prove the signature locally against the shared secret. The payload is
 * the backend's own words once the HMAC matches, so the identity may be read
 * from it. A failure here is NOT retried against the backend: the same secret
 * yields the same verdict, and a fallback would let a flood of forged tokens
 * each buy an upstream round-trip.
 */
function verifyLocally(decoded: DecodedJwt, secret: string): VerifiedIdentity | null {
  const expected = crypto.createHmac('sha256', secret).update(decoded.signingInput).digest();
  const actual = Buffer.from(decoded.signature, 'base64url');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return null;
  }

  const sub = decoded.payload.sub;
  if (typeof sub !== 'string' || !sub) return null;
  return { userId: sub, role: readRole(decoded.payload.role) };
}

/**
 * Path 2: let the backend identify the caller. `expiresAtMs` is the token's own
 * `exp` (already checked to be in the future) and caps how long a hit may live.
 */
async function verifyWithBackend(
  token: string,
  expiresAtMs: number | null,
  now: number,
): Promise<VerifiedIdentity | null> {
  const key = crypto.createHash('sha256').update(token).digest('hex');
  const cached = verifyCache.get(key);
  if (cached && now < cached.expiresAt) return cached.identity;

  let profile: BackendProfile | undefined;
  try {
    profile = await backendRequest<BackendProfile>('GET', '/users/profile', {
      token,
      timeoutMs: IDENTITY_TIMEOUT_MS,
    });
  } catch {
    // A 401/403 (bad signature, revoked token), a 5xx, a timeout, or a network
    // failure are all indistinguishable from "this caller is not authenticated"
    // as far as this server may assume. Fail closed.
    return null;
  }

  // GET /users/profile answers 200 with a null body when the id in a
  // *validly signed* token no longer resolves to a user (deleted account), so a
  // 2xx alone is not proof of identity — require the id the backend resolved.
  if (!profile || typeof profile.id !== 'string' || !profile.id) return null;

  const identity: VerifiedIdentity = { userId: profile.id, role: readRole(profile.role) };

  if (verifyCache.size >= VERIFY_CACHE_MAX_ENTRIES) {
    sweepCache(now);
    // Still full of live entries: this is a pure optimization, so drop it
    // wholesale rather than let it grow without bound.
    if (verifyCache.size >= VERIFY_CACHE_MAX_ENTRIES) verifyCache.clear();
  }
  const expiresAt =
    expiresAtMs === null ? now + VERIFY_CACHE_TTL_MS : Math.min(now + VERIFY_CACHE_TTL_MS, expiresAtMs);
  verifyCache.set(key, { identity, expiresAt });

  return identity;
}

/**
 * Verify a bearer token and return the identity it proves, or null to reject.
 * Callers MUST treat null as "deny" — there is no decoded-but-unverified result.
 */
export async function verifyBackendJwt(token: string): Promise<VerifiedIdentity | null> {
  const decoded = decodeJwt(token);
  if (!decoded) return null;

  // Reject expired tokens up front (the backend uses ignoreExpiration:false
  // too). Reading `exp` off an unverified payload is safe in this direction: it
  // can only cause a rejection, never grant one.
  const expiresAtMs = typeof decoded.payload.exp === 'number' ? decoded.payload.exp * 1000 : null;
  const now = Date.now();
  if (expiresAtMs !== null && expiresAtMs <= now) return null;

  const secret = process.env.MCP_BACKEND_JWT_SECRET;
  if (secret) return verifyLocally(decoded, secret);

  return verifyWithBackend(token, expiresAtMs, now);
}
