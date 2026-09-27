import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { verifyBackendJwt } from '@/lib/jwt';
import { looksLikeAccessEnvelope } from '@/lib/oauth/envelope';
import { openAccessToken } from '@/lib/oauth/tokens';
import { oauthEnabled } from '@/lib/oauth/config';
import { TOOL_SCOPES, type ToolScope } from '@/tools/registry';

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
  /**
   * OAuth scopes this principal may use (see `lib/oauth/scopes`): the granted
   * set for an OAuth token, `read` only for the operator key, every scope for
   * a verified raw backend JWT (a first-party session is not scope-limited).
   */
  scopes?: ToolScope[];
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
 *     POST /api/v1/users/login) → VERIFIED before it authenticates, never
 *     decoded and trusted (SPLIT-1438; lib/jwt.ts): in-process HS256 when
 *     MCP_BACKEND_JWT_SECRET is configured, otherwise against the backend
 *     itself, with the identity taken from the backend's answer. Fails
 *     closed either way. Kept for first-party integrations that already hold
 *     a backend session; forwarded as-is. An unverifiable JWT is a base64
 *     string anyone can type, and it must never unlock even the public tools
 *     or a rate-limit bucket of its own.
 * The backend re-validates every forwarded token; it is the single authority
 * for auth, RBAC and ownership. The MCP holds no database, payment or LLM
 * client of its own; every tool is a thin client of the backend REST API
 * (SPLIT-226, docs/adr/0001-mcp-is-a-backend-rest-client.md).
 */
export async function authMiddleware(request: NextRequest): Promise<AuthResult> {
  const authHeader = request.headers.get('authorization');
  const apiKey = request.headers.get('x-api-key');

  const operatorKey = process.env.MCP_API_KEY;
  if (!operatorKey && !oauthEnabled() && !process.env.MCP_BACKEND_JWT_SECRET) {
    return { success: false, error: 'Server auth not configured' };
  }
  if (apiKey && operatorKey && timingSafeEqualStr(apiKey, operatorKey)) {
    return { success: true, role: 'admin', kind: 'operator', scopes: ['read'] };
  }

  if (authHeader?.startsWith('Bearer ')) {
    const bearer = authHeader.substring(7).trim();

    if (looksLikeAccessEnvelope(bearer)) {
      if (!oauthEnabled()) return { success: false, error: 'Invalid token', invalidCredentials: true };
      const at = openAccessToken(bearer);
      if (!at) return { success: false, error: 'Invalid or expired token', invalidCredentials: true };
      return { success: true, userId: at.sub, role: at.role || 'renter', email: at.email, token: at.bt, kind: 'oauth', scopes: at.scp };
    }

    // SPLIT-1438: the principal comes from a VERIFIED identity (local HS256
    // when the shared secret is configured, otherwise the backend's own
    // answer), never from the token's base64 payload. An unverifiable bearer
    // is rejected rather than decoded-and-trusted.
    const identity = await verifyBackendJwt(bearer);
    if (!identity) {
      return { success: false, error: 'Invalid token', invalidCredentials: true };
    }
    return {
      success: true,
      userId: identity.userId,
      role: identity.role,
      token: bearer,
      kind: 'jwt',
      scopes: [...TOOL_SCOPES],
    };
  }

  // A non-operator x-api-key with no bearer, or no credentials at all.
  if (apiKey) return { success: false, error: 'No authentication provided', invalidCredentials: true };
  return { success: false, error: 'No authentication provided' };
}
