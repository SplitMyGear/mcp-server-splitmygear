/**
 * Issuance and redemption of the OAuth artifacts (authorization code, access
 * token, refresh token) as sealed envelopes — see `envelope.ts`.
 *
 * Access token  = envelope over { user, client, backend JWT }. The MCP auth
 *                 middleware opens it and forwards the INNER backend JWT to the
 *                 REST API, so the backend keeps validating every call itself.
 *                 Lifetime tracks the backend JWT's own `exp`.
 * Refresh token = envelope over { user, client, backend refresh token }. The
 *                 `refresh_token` grant proxies `POST /auth/refresh`, which
 *                 rotates the backend pair; we re-seal the new pair.
 * Auth code     = envelope over { client binding, PKCE challenge, the freshly
 *                 minted backend session }. Short-lived (2 min), single-use
 *                 (best-effort per-instance replay cache; PKCE + client/redirect
 *                 binding make a replay useless without the verifier anyway).
 */
import crypto from 'crypto';
import { open, seal, nowSeconds } from './envelope';
import { readBackendJwtClaims } from '@/lib/jwt';
import type { BackendUser } from './backend-auth';

export const AUTH_CODE_TTL_S = 120;
/** Upper bound on how long a refresh envelope stays redeemable (backend enforces the real TTL). */
export const REFRESH_TOKEN_TTL_S = 30 * 24 * 3600;
/** Fallback access lifetime if the backend JWT carries no exp (it always does). */
const DEFAULT_ACCESS_TTL_S = 15 * 60;

export interface AuthCodePayload {
  cid: string;
  ru: string;
  cc: string;
  res?: string;
  sub: string;
  role: string;
  email: string;
  at: string;
  rt: string;
  jti: string;
  exp: number;
  iat: number;
}

export interface AccessTokenPayload {
  sub: string;
  role: string;
  email: string;
  cid: string;
  /** The backend JWT this envelope wraps. */
  bt: string;
  exp: number;
  iat: number;
}

export interface RefreshTokenPayload {
  sub: string;
  role: string;
  email: string;
  cid: string;
  /** Backend refresh token. */
  brt: string;
  /** Backend access token at issue (lets /oauth/revoke authenticate the logout). */
  bt: string;
  exp: number;
  iat: number;
}

export interface OAuthTokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
}

export function issueAuthorizationCode(params: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource?: string;
  user: BackendUser;
  backendAccessToken: string;
  backendRefreshToken: string;
}): string {
  const iat = nowSeconds();
  return seal<AuthCodePayload>('code', {
    cid: params.clientId,
    ru: params.redirectUri,
    cc: params.codeChallenge,
    res: params.resource,
    sub: params.user.id,
    role: params.user.role,
    email: params.user.email,
    at: params.backendAccessToken,
    rt: params.backendRefreshToken,
    jti: crypto.randomBytes(16).toString('base64url'),
    iat,
    exp: iat + AUTH_CODE_TTL_S,
  });
}

export function openAuthorizationCode(code: string): AuthCodePayload | null {
  return open<AuthCodePayload>('code', code);
}

/** Best-effort single-use enforcement for codes (per serverless instance). */
const redeemedCodes = new Map<string, number>();
export function markCodeRedeemed(jti: string, exp: number): boolean {
  const now = nowSeconds();
  if (redeemedCodes.size > 5_000) {
    for (const [k, e] of redeemedCodes) if (e <= now) redeemedCodes.delete(k);
  }
  if (redeemedCodes.has(jti)) return false;
  redeemedCodes.set(jti, exp);
  return true;
}

/** Wrap a backend session for a client. `expires_in` follows the backend JWT. */
export function issueTokens(params: {
  clientId: string;
  user: Pick<BackendUser, 'id' | 'role' | 'email'>;
  backendAccessToken: string;
  backendRefreshToken: string;
}): OAuthTokenResponse | null {
  const claims = readBackendJwtClaims(params.backendAccessToken);
  if (!claims) return null; // signature/expiry rejected → never wrap a token we could not read
  const iat = nowSeconds();
  const exp = typeof claims.exp === 'number' ? claims.exp : iat + DEFAULT_ACCESS_TTL_S;
  const role = claims.role || params.user.role;
  const sub = claims.sub || params.user.id;
  const email = claims.email || params.user.email;
  const access_token = seal<AccessTokenPayload>('at', {
    sub,
    role,
    email,
    cid: params.clientId,
    bt: params.backendAccessToken,
    iat,
    exp,
  });
  const refresh_token = seal<RefreshTokenPayload>('rt', {
    sub,
    role,
    email,
    cid: params.clientId,
    brt: params.backendRefreshToken,
    bt: params.backendAccessToken,
    iat,
    exp: iat + REFRESH_TOKEN_TTL_S,
  });
  return { access_token, token_type: 'Bearer', expires_in: Math.max(1, exp - iat), refresh_token };
}

export function openAccessToken(token: string): AccessTokenPayload | null {
  const payload = open<AccessTokenPayload>('at', token);
  if (!payload || typeof payload.sub !== 'string' || typeof payload.bt !== 'string') return null;
  // Defense in depth: the wrapped backend JWT must itself still be valid.
  const inner = readBackendJwtClaims(payload.bt);
  if (!inner?.sub || inner.sub !== payload.sub) return null;
  return payload;
}

export function openRefreshToken(token: string): RefreshTokenPayload | null {
  const payload = open<RefreshTokenPayload>('rt', token);
  if (!payload || typeof payload.sub !== 'string' || typeof payload.brt !== 'string') return null;
  return payload;
}
