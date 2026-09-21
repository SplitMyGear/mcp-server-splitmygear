import crypto from 'crypto';
import { backendRequest } from '@/lib/backend-client';

/**
 * Splitt backend JWTs (HS256, `{ sub, email, role, typ, exp }`, issued by
 * POST /api/v1/users/login). Two readers with deliberately different trust:
 *
 *  - `verifyBackendJwt` is the ONLY gate for a RAW bearer presented by an
 *    arbitrary caller (middleware/auth.ts). Verification is MANDATORY and every
 *    failure fails CLOSED (SPLIT-1438). Before that fix this module used to
 *    decode-and-trust whenever `MCP_BACKEND_JWT_SECRET` was absent — which was
 *    the deployed configuration — so any `<header>.<base64 claims>.junk`
 *    string with a future `exp` cleared authMiddleware. Two paths, one verdict:
 *
 *     1. LOCAL (preferred): `MCP_BACKEND_JWT_SECRET` = the backend's
 *        `JWT_SECRET` → prove the HS256 signature in-process (alg pinned to
 *        HS256, timing-safe compare). No network hop, so this is strictly
 *        better; it is the recommended deployment (see .env.example).
 *     2. REMOTE (fallback, works with no new env var): ask the backend —
 *        already the single authority this server defers to for auth/RBAC/
 *        ownership — who the caller is, via `GET /users/profile` with the
 *        caller's own token. This mirrors the frontend BFF's `resolveRole()`.
 *        The identity is taken from the BACKEND's response, never from the
 *        client's payload.
 *
 *    Rejected: malformed token, non-access token type, expired token, a header
 *    that is not HS256, bad signature, non-200 from the backend, an
 *    unresolvable user, and an unreachable/slow backend.
 *
 *  - `decodeSealedBackendJwtClaims` only DECODES (shape, token type and expiry
 *    — NO signature check). It is acceptable ONLY for a token whose provenance
 *    is already proven by something stronger than its own signature: the
 *    backend JWT sealed inside an OAuth access envelope (lib/oauth/tokens.ts)
 *    came straight from the backend's login/refresh response over a
 *    server-to-server call, and the envelope's AES-GCM authentication tag
 *    proves THIS server sealed it. It must never be called on a bearer a
 *    client typed, and nothing under src/middleware may import it (a rail in
 *    __tests__/jwt.test.ts enforces that).
 */

/** Role assumed when the verified identity carries none (matches the backend's least-privileged role). */
const DEFAULT_ROLE = 'renter';

/** Only the backend's ACCESS tokens mint a session (mirrors its JwtStrategy); handoff/refresh types never do. */
const ACCESS_TOKEN_TYPE = 'access';

/** The backend signs with HS256 only; anything else is an alg-confusion attempt, not a token. */
const REQUIRED_ALG = 'HS256';

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
 * outlives the token's own `exp`. Per-instance and best-effort like the
 * in-memory rate limiter: a cold lambda simply re-verifies, and nothing
 * security-relevant depends on a hit. Successes only: a backend blip cannot
 * stick, and a forged-token flood cannot be cheaply cached.
 */
const VERIFY_CACHE_TTL_MS = 60_000;
const VERIFY_CACHE_MAX_ENTRIES = 1_000;
const verifyCache = new Map<string, { identity: VerifiedIdentity; expiresAt: number }>();

export interface VerifiedIdentity {
  /** The backend's user id — proven by the signature, or resolved by the backend itself. */
  userId: string;
  role: string;
}

/** Claims read off a SEALED backend JWT — see `decodeSealedBackendJwtClaims`. */
export interface BackendJwtClaims {
  sub: string;
  role?: string;
  email?: string;
  exp?: number;
  typ?: string;
}

/** The only two fields this server reads off the backend's authenticated-profile projection. */
interface BackendProfile {
  id?: unknown;
  role?: unknown;
}

interface JwtPayload {
  sub?: unknown;
  role?: unknown;
  email?: unknown;
  exp?: unknown;
  typ?: unknown;
}

interface DecodedJwt {
  header: { alg?: unknown };
  signingInput: string;
  signature: string;
  payload: JwtPayload;
}

function parseSegment(segment: string): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Split and base64url-decode a token. This is a PARSE, not a validation — the
 * result is untrusted until one of the two verification paths blesses it. A
 * header that does not parse is kept as `{}` so it fails the alg pin rather
 * than aborting the parse (either way the token is rejected).
 */
function decodeJwt(token: string): DecodedJwt | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const payload = parseSegment(parts[1]);
  if (!payload) return null;
  return {
    header: parseSegment(parts[0]) ?? {},
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: parts[2],
    payload: payload as JwtPayload,
  };
}

function readRole(role: unknown): string {
  return typeof role === 'string' && role ? role : DEFAULT_ROLE;
}

/** The token's `exp` in ms, or null when it carries none. */
function expiresAtOf(payload: JwtPayload): number | null {
  return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
}

/**
 * Checks that can only DENY, applied on both paths before any signature work.
 * Reading these off an unverified payload is safe in this direction: a forged
 * `typ` or `exp` can cause a rejection, never grant one.
 */
function rejectedUpFront(payload: JwtPayload, now: number): boolean {
  if (typeof payload.typ === 'string' && payload.typ !== ACCESS_TOKEN_TYPE) return true;
  const expiresAtMs = expiresAtOf(payload);
  return expiresAtMs !== null && expiresAtMs <= now;
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
  if (decoded.header.alg !== REQUIRED_ALG) return null;
  const expected = crypto.createHmac('sha256', secret).update(decoded.signingInput).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(decoded.signature, 'base64url');
  } catch {
    return null;
  }
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
 * Verify a RAW bearer token and return the identity it proves, or null to
 * reject. Callers MUST treat null as "deny" — there is no decoded-but-unverified
 * result on this path.
 */
export async function verifyBackendJwt(token: string): Promise<VerifiedIdentity | null> {
  const decoded = decodeJwt(token);
  if (!decoded) return null;

  const now = Date.now();
  if (rejectedUpFront(decoded.payload, now)) return null;

  const secret = process.env.MCP_BACKEND_JWT_SECRET;
  if (secret) return verifyLocally(decoded, secret);

  return verifyWithBackend(token, expiresAtOf(decoded.payload), now);
}

/**
 * Decode the claims of a backend JWT WITHOUT checking its signature.
 *
 * ONLY for tokens that came out of an AES-GCM envelope this server sealed
 * (lib/oauth/tokens.ts: the backend JWT wrapped in an access token, or the one
 * just returned by the backend's login/refresh that is about to be wrapped).
 * Their provenance is the sealed envelope / the server-to-server response, not
 * this signature. Never call it on a bearer presented by a client — that path
 * is `verifyBackendJwt`, and src/middleware must not import this function.
 */
export function decodeSealedBackendJwtClaims(token: string): BackendJwtClaims | null {
  const decoded = decodeJwt(token);
  if (!decoded) return null;
  if (rejectedUpFront(decoded.payload, Date.now())) return null;
  const { sub, role, email, exp, typ } = decoded.payload;
  if (typeof sub !== 'string' || !sub) return null;
  return {
    sub,
    role: typeof role === 'string' ? role : undefined,
    email: typeof email === 'string' ? email : undefined,
    exp: typeof exp === 'number' ? exp : undefined,
    typ: typeof typ === 'string' ? typ : undefined,
  };
}
