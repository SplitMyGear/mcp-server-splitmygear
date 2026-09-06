import crypto from 'crypto';

/**
 * Splitt backend JWTs (HS256, `{ sub, email, role, entitlements, exp }`, issued
 * by POST /api/v1/users/login).
 *
 * Two readers, deliberately separate:
 *  - `decodeBackendJwtClaims` only DECODES (plus expiry). Safe only for tokens
 *    whose provenance is already proven: the JWT sealed inside an OAuth access
 *    envelope came straight from the backend's login/refresh response over a
 *    server-to-server call, and the envelope's authentication tag proves this
 *    server issued it.
 *  - `verifyBackendJwtClaims` VERIFIES the HS256 signature with
 *    `MCP_BACKEND_JWT_SECRET` (= the backend's `JWT_SECRET`) and returns null
 *    when the secret is not configured. It is the only acceptable gate for a
 *    raw bearer token presented by an arbitrary caller: an unverified JWT is
 *    just a base64 string anyone can type, so it must never authenticate.
 */
export interface BackendJwtClaims {
  sub?: string;
  role?: string;
  email?: string;
  exp?: number;
  typ?: string;
}

function splitJwt(token: string): [string, string, string] | null {
  const parts = token.split('.');
  return parts.length === 3 ? (parts as [string, string, string]) : null;
}

function parseClaims(payloadSegment: string): BackendJwtClaims | null {
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== 'object') return null;
  const c = claims as BackendJwtClaims;
  if (typeof c.sub !== 'string' || !c.sub) return null;
  // Mirrors the backend's JwtStrategy: only access tokens mint a session.
  if (c.typ && c.typ !== 'access') return null;
  if (typeof c.exp === 'number' && c.exp * 1000 <= Date.now()) return null;
  return c;
}

/** Decode + expiry only. See the module comment for when this is acceptable. */
export function decodeBackendJwtClaims(token: string): BackendJwtClaims | null {
  const parts = splitJwt(token);
  return parts ? parseClaims(parts[1]) : null;
}

/** Signature-verified read; null unless `MCP_BACKEND_JWT_SECRET` is set and matches. */
export function verifyBackendJwtClaims(token: string): BackendJwtClaims | null {
  const secret = process.env.MCP_BACKEND_JWT_SECRET;
  if (!secret) return null;
  const parts = splitJwt(token);
  if (!parts) return null;
  let header: { alg?: string } | null = null;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (header?.alg !== 'HS256') return null;
  const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(parts[2], 'base64url');
  } catch {
    return null;
  }
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  return parseClaims(parts[1]);
}

/**
 * Backwards-compatible reader used by the OAuth token layer: verifies when the
 * secret is configured, otherwise decodes. Callers must only pass tokens with
 * proven provenance (see module comment).
 */
export function readBackendJwtClaims(token: string): BackendJwtClaims | null {
  return process.env.MCP_BACKEND_JWT_SECRET ? verifyBackendJwtClaims(token) : decodeBackendJwtClaims(token);
}
