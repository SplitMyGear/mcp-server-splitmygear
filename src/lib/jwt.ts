import crypto from 'crypto';

/**
 * Reads the claims from a SplitMyGear backend JWT (HS256, `{ sub, email, role }`,
 * issued by POST /api/v1/users/login). The backend is the authority and
 * re-validates every forwarded token, so by default we only DECODE the token to
 * learn the acting user. When the operator sets `MCP_BACKEND_JWT_SECRET` (= the
 * backend's `JWT_SECRET`) we additionally VERIFY the signature and expiry here,
 * rejecting forged/stale tokens before they reach a non-forwarding tool — pure
 * defense-in-depth.
 */
export interface BackendJwtClaims {
  sub?: string;
  role?: string;
  email?: string;
  exp?: number;
}

export function readBackendJwtClaims(token: string): BackendJwtClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  let claims: BackendJwtClaims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== 'object') return null;

  // Reject expired tokens (the backend uses ignoreExpiration:false too).
  if (typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now()) {
    return null;
  }

  const secret = process.env.MCP_BACKEND_JWT_SECRET;
  if (secret) {
    const signingInput = `${parts[0]}.${parts[1]}`;
    const expected = crypto.createHmac('sha256', secret).update(signingInput).digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(parts[2], 'base64url');
    } catch {
      return null;
    }
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      return null;
    }
  }

  return claims;
}
