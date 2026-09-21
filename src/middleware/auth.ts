import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { verifyBackendJwt } from '@/lib/jwt';

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

export interface AuthResult {
  success: boolean;
  userId?: string;
  role?: string;
  /**
   * The caller's raw backend JWT, forwarded by user-scoped tools to the backend
   * REST API (SPLIT-226). Present only on the bearer-token path — the operator
   * key carries no per-user token, so it cannot drive user-scoped mutations.
   */
  token?: string;
  error?: string;
}

/**
 * Two ways in, deny-by-default (security lockdown 2026-06-12):
 *  1. The operator API key (`x-api-key === MCP_API_KEY`) → role `admin`, no
 *     per-user token (cannot drive user-scoped backend mutations).
 *  2. A SplitMyGear backend JWT (`Authorization: Bearer …`, issued by
 *     POST /api/v1/users/login) → VERIFIED (lib/jwt.ts: local HS256 when the
 *     shared secret is configured, otherwise against the backend itself) for the
 *     acting user; user-scoped tools forward it to the backend, the single
 *     authority for auth/RBAC/ownership.
 * The MCP holds no database, payment or LLM client of its own; every tool is a
 * thin client of the backend REST API
 * (docs/adr/0001-mcp-is-a-backend-rest-client.md).
 */
export async function authMiddleware(request: NextRequest): Promise<AuthResult> {
  const authHeader = request.headers.get('authorization');
  const apiKey = request.headers.get('x-api-key');

  const operatorKey = process.env.MCP_API_KEY;
  if (!operatorKey) {
    return { success: false, error: 'Server auth not configured' };
  }
  if (apiKey && timingSafeEqualStr(apiKey, operatorKey)) {
    return { success: true, role: 'admin' };
  }

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    // Security fix (2026-09-11 review): the principal comes from a VERIFIED
    // identity, never from the token's own base64 payload. An unverifiable
    // bearer is rejected rather than decoded-and-trusted.
    const identity = await verifyBackendJwt(token);
    if (!identity) {
      return { success: false, error: 'Invalid token' };
    }
    return {
      success: true,
      userId: identity.userId,
      role: identity.role,
      token,
    };
  }

  // A non-operator x-api-key with no bearer, or no credentials at all.
  return { success: false, error: 'No authentication provided' };
}
