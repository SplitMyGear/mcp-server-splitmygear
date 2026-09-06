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
 *                 minted backend session }. Short-lived (2 min), single-use:
 *                 the replay cache is the shared store when one is configured
 *                 (`mcp:code:<jti>`, cross-instance) and a per-instance set
 *                 otherwise or while the store is unavailable (PKCE +
 *                 client/redirect binding make a replay useless without the
 *                 verifier anyway).
 *
 * Scopes: the code carries the granted scopes (`sc`), and both tokens carry
 * them as `scp`; the auth middleware hands them to the tool registry, which
 * lists and runs only tools in the granted scopes. A refresh may narrow them.
 */
import crypto from 'crypto';
import { open, seal, nowSeconds } from './envelope';
import { readBackendJwtClaims } from '@/lib/jwt';
import { redeemOnce, sharedStoreEnabled, warnIfNoSharedStore } from '@/lib/shared-store';
import { coerceScopes, formatScope, type ToolScope } from './scopes';
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
  /** Scopes the user granted (see `lib/oauth/scopes`). */
  sc: ToolScope[];
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
  /** Granted scopes; the registry hides and refuses tools outside them. */
  scp: ToolScope[];
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
  /** Granted scopes; a refresh may only narrow them. */
  scp: ToolScope[];
  exp: number;
  iat: number;
}

export interface OAuthTokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  /** Granted scopes, space-separated (RFC 6749 §5.1). */
  scope: string;
}

export function issueAuthorizationCode(params: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource?: string;
  user: BackendUser;
  backendAccessToken: string;
  backendRefreshToken: string;
  scopes: ToolScope[];
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
    sc: coerceScopes(params.scopes),
    jti: crypto.randomBytes(16).toString('base64url'),
    iat,
    exp: iat + AUTH_CODE_TTL_S,
  });
}

export function openAuthorizationCode(code: string): AuthCodePayload | null {
  const payload = open<AuthCodePayload>('code', code);
  if (!payload || typeof payload.sub !== 'string' || typeof payload.at !== 'string') return null;
  return { ...payload, sc: coerceScopes(payload.sc) };
}

/** Per-instance replay cache: jti -> code expiry (entries are useless past it). */
const redeemedCodes = new Map<string, number>();

function markRedeemedLocally(jti: string, exp: number, now: number): boolean {
  if (redeemedCodes.size > 5_000) {
    for (const [k, e] of redeemedCodes) if (e <= now) redeemedCodes.delete(k);
  }
  if (redeemedCodes.has(jti)) return false;
  redeemedCodes.set(jti, exp);
  return true;
}

/**
 * Single-use enforcement for authorization codes: true on the first
 * redemption of `jti`, false on a replay. With a shared store configured the
 * decision is `redeemOnce('mcp:code:<jti>')` held until the code would have
 * expired anyway, so a replay on ANOTHER serverless instance is refused too;
 * the local set is still written as a second layer and decides alone when the
 * store is not configured or unavailable for this request.
 */
export async function markCodeRedeemed(jti: string, exp: number): Promise<boolean> {
  // Once per cold instance, say out loud that single-use is per-instance here.
  warnIfNoSharedStore();
  const now = nowSeconds();
  if (redeemedCodes.has(jti)) return false;
  if (sharedStoreEnabled()) {
    const first = await redeemOnce(`mcp:code:${jti}`, Math.max(1, exp - now));
    if (first !== null) {
      markRedeemedLocally(jti, exp, now);
      return first;
    }
  }
  return markRedeemedLocally(jti, exp, now);
}

/** Wrap a backend session for a client. `expires_in` follows the backend JWT; `scope` echoes the grant. */
export function issueTokens(params: {
  clientId: string;
  user: Pick<BackendUser, 'id' | 'role' | 'email'>;
  backendAccessToken: string;
  backendRefreshToken: string;
  scopes: ToolScope[];
}): OAuthTokenResponse | null {
  const claims = readBackendJwtClaims(params.backendAccessToken);
  if (!claims) return null; // signature/expiry rejected → never wrap a token we could not read
  const iat = nowSeconds();
  const exp = typeof claims.exp === 'number' ? claims.exp : iat + DEFAULT_ACCESS_TTL_S;
  const role = claims.role || params.user.role;
  const sub = claims.sub || params.user.id;
  const email = claims.email || params.user.email;
  const scp = coerceScopes(params.scopes);
  const access_token = seal<AccessTokenPayload>('at', {
    sub,
    role,
    email,
    cid: params.clientId,
    bt: params.backendAccessToken,
    scp,
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
    scp,
    iat,
    exp: iat + REFRESH_TOKEN_TTL_S,
  });
  return { access_token, token_type: 'Bearer', expires_in: Math.max(1, exp - iat), refresh_token, scope: formatScope(scp) };
}

export function openAccessToken(token: string): AccessTokenPayload | null {
  const payload = open<AccessTokenPayload>('at', token);
  if (!payload || typeof payload.sub !== 'string' || typeof payload.bt !== 'string') return null;
  // Defense in depth: the wrapped backend JWT must itself still be valid.
  const inner = readBackendJwtClaims(payload.bt);
  if (!inner?.sub || inner.sub !== payload.sub) return null;
  return { ...payload, scp: coerceScopes(payload.scp) };
}

export function openRefreshToken(token: string): RefreshTokenPayload | null {
  const payload = open<RefreshTokenPayload>('rt', token);
  if (!payload || typeof payload.sub !== 'string' || typeof payload.brt !== 'string') return null;
  return { ...payload, scp: coerceScopes(payload.scp) };
}
