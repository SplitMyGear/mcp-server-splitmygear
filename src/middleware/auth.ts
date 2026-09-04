import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { readBackendJwtClaims } from '@/lib/jwt';
import { looksLikeAccessEnvelope } from '@/lib/oauth/envelope';
import { openAccessToken } from '@/lib/oauth/tokens';
import { oauthEnabled } from '@/lib/oauth/config';

/**
 * SPLIT-335: constant-time secret comparison. A plain `a === b` short-circuits
 * on the first differing byte, leaking the operator key length/prefix via
 * response timing. Compare digests of equal length instead.
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = crypto.createHash('sha256').update(a).digest();
  const bb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ab, bb);
}

/** How the caller authenticated — drives tool visibility and rate-limit keys. */
export type PrincipalKind = 'operator' | 'oauth' | 'jwt';

export interface AuthResult {
  success: boolean;
  userId?: string;
  role?: string;
  email?: string;
  /**
   * The caller's raw BACKEND JWT, forwarded by user-scoped tools to the REST
   * API (SPLIT-226). Present only on the user paths — the operator key carries
   * no per-user token, so it cannot drive user-scoped backend calls.
   */
  token?: string;
  kind?: PrincipalKind;
  error?: string;
  /**
   * Distinguishes "no credentials" from "credentials presented but rejected"
   * so the 401 can carry `error="invalid_token"` per RFC 6750 §3.
   */
  invalidCredentials?: boolean;
}

/**
 * Three ways in, deny-by-default:
 *  1. The operator API key (`x-api-key === MCP_API_KEY`) → kind `operator`,
 *     role `admin`, no per-user token (public/read tools only).
 *  2. An OAuth access token issued by THIS server (`smg_at.…`, see
 *     lib/oauth) → decrypted; the wrapped backend JWT is what tools forward.
 *  3. A raw Splitt backend JWT (`Authorization: Bearer …`, issued by
 *     POST /api/v1/users/login) → decoded (and signature-verified when
 *     MCP_BACKEND_JWT_SECRET is set); forwarded as-is. Kept for first-party
 *     integrations that already hold a backend session.
 * The backend re-validates every forwarded token; it is the single authority
 * for auth, RBAC and ownership. No Supabase client exists here (SPLIT-226).
 */
export async function authMiddleware(request: NextRequest): Promise<AuthResult> {
  const authHeader = request.headers.get('authorization');
  const apiKey = request.headers.get('x-api-key');

  const operatorKey = process.env.MCP_API_KEY;
  if (!operatorKey) {
    return { success: false, error: 'Server auth not configured' };
  }
  if (apiKey && timingSafeEqualStr(apiKey, operatorKey)) {
    return { success: true, role: 'admin', kind: 'operator' };
  }

  if (authHeader?.startsWith('Bearer ')) {
    const bearer = authHeader.substring(7).trim();

    if (looksLikeAccessEnvelope(bearer)) {
      if (!oauthEnabled()) return { success: false, error: 'Invalid token', invalidCredentials: true };
      const at = openAccessToken(bearer);
      if (!at) return { success: false, error: 'Invalid or expired token', invalidCredentials: true };
      return { success: true, userId: at.sub, role: at.role || 'renter', email: at.email, token: at.bt, kind: 'oauth' };
    }

    const claims = readBackendJwtClaims(bearer);
    if (!claims?.sub) {
      return { success: false, error: 'Invalid token', invalidCredentials: true };
    }
    return {
      success: true,
      userId: claims.sub,
      role: claims.role || 'renter',
      email: claims.email,
      token: bearer,
      kind: 'jwt',
    };
  }

  // A non-operator x-api-key with no bearer, or no credentials at all.
  if (apiKey) return { success: false, error: 'No authentication provided', invalidCredentials: true };
  return { success: false, error: 'No authentication provided' };
}
