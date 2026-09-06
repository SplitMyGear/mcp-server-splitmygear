/**
 * The OAuth login bridge: the only place the MCP server ever sees a user's
 * password or one-time code. Each function is a thin call to the Splitt
 * backend's own auth endpoints — the backend stays the single authority for
 * credentials, 2FA, throttling, suspension and session minting.
 *
 *   POST /users/login          → tokens, or a 2FA challenge envelope
 *   POST /auth/2fa/otp/send    → email the one-time code for a challenge
 *   POST /auth/2fa/otp/verify  → tokens once the code is right
 *   POST /auth/refresh         → rotate an access/refresh pair
 *   POST /auth/logout          → revoke a refresh token
 *   GET  /auth/providers       → which social providers the web flow can serve
 *   POST /auth/oauth/exchange  → swap the one-time code a Google/Apple
 *                                round-trip ends with for tokens (or 2FA)
 *
 * Client context: when `MCP_BFF_RELAY_KEY` is configured (the backend's
 * `BFF_RELAY_KEY`), the end user's IP is relayed via the backend's trusted
 * `x-smg-relay-key` / `x-smg-client-ip` headers, so its per-IP brute-force
 * throttle keys on the real caller instead of on this server's shared egress
 * address (which would otherwise let one attacker lock out every MCP login).
 */
import { backendRequest, BackendApiError } from '@/lib/backend-client';

export interface ClientContext {
  ip?: string;
  userAgent?: string;
}

export interface BackendUser {
  id: string;
  email: string;
  role: string;
  firstName?: string;
  lastName?: string;
  entitlements?: string[];
  vendorOnboardingStatus?: string;
}

export interface BackendSession {
  accessToken: string;
  refreshToken: string;
  user: BackendUser;
}

export interface TwoFactorChallenge {
  challengeToken: string;
  methods: string[];
  maskedEmail: string;
  expiresAt: string;
}

export type LoginOutcome =
  | { kind: 'session'; session: BackendSession }
  | { kind: 'two_factor'; challenge: TwoFactorChallenge };

/** The social providers the backend's web flow can start (`GET /auth/google|apple`). */
export type SocialProvider = 'google' | 'apple';
export const SOCIAL_PROVIDERS: readonly SocialProvider[] = ['google', 'apple'];

export function isSocialProvider(value: unknown): value is SocialProvider {
  return typeof value === 'string' && (SOCIAL_PROVIDERS as readonly string[]).includes(value);
}

/** How long the sign-in page waits for `GET /auth/providers` before hiding the social buttons. */
const PROVIDERS_TIMEOUT_MS = 3_000;

/** A user-safe failure from the backend auth endpoints. */
export class AuthBridgeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'AuthBridgeError';
    this.status = status;
  }
}

const MAX_UA_LENGTH = 200;

/** Printable ASCII only, bounded: the UA is stored by the backend against the session. */
function sanitizeUserAgent(ua: string | undefined): string {
  const clean = (ua ?? '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, MAX_UA_LENGTH);
  return clean ? `${clean} (via splitt-mcp)` : 'splitt-mcp';
}

function relayHeaders(ctx: ClientContext): Record<string, string> {
  const headers: Record<string, string> = {};
  const relayKey = process.env.MCP_BFF_RELAY_KEY;
  // `ctx.ip` is only ever set from trusted proxy headers and validated as an
  // IP (see http.clientIp); without one, the backend throttles on our address.
  if (relayKey && ctx.ip) {
    headers['x-smg-relay-key'] = relayKey;
    headers['x-smg-client-ip'] = ctx.ip;
  }
  headers['User-Agent'] = sanitizeUserAgent(ctx.userAgent);
  return headers;
}

/** Normalise backend failures into messages safe to show on the login page. */
function toBridgeError(error: unknown, fallback: string): AuthBridgeError {
  if (error instanceof BackendApiError) {
    if (error.status === 401) return new AuthBridgeError(401, error.message || 'Invalid email or password');
    if (error.status === 429) return new AuthBridgeError(429, 'Too many attempts. Please wait a few minutes and try again.');
    if (error.status === 400) return new AuthBridgeError(400, error.message || fallback);
    if (error.status === 403) return new AuthBridgeError(403, error.message || fallback);
    return new AuthBridgeError(502, 'Splitt is temporarily unavailable. Please try again shortly.');
  }
  return new AuthBridgeError(502, fallback);
}

function isSessionShape(value: unknown): value is BackendSession {
  const v = value as Partial<BackendSession> | null;
  return !!v && typeof v.accessToken === 'string' && typeof v.refreshToken === 'string' && !!v.user && typeof v.user.id === 'string';
}

/**
 * The `/users/login` envelope is either a session or a 2FA challenge; the
 * social exchange endpoint answers with the exact same shapes (the backend
 * mints both through one path), so both bridges share this reader.
 */
function toLoginOutcome(result: unknown, unexpected: string): LoginOutcome {
  const r = result as Record<string, unknown> | null;
  if (r && r.twoFactorRequired === true && typeof r.challengeToken === 'string') {
    return {
      kind: 'two_factor',
      challenge: {
        challengeToken: r.challengeToken,
        methods: Array.isArray(r.methods) ? (r.methods as string[]) : ['email_otp'],
        maskedEmail: typeof r.maskedEmail === 'string' ? r.maskedEmail : '',
        expiresAt: typeof r.expiresAt === 'string' ? r.expiresAt : '',
      },
    };
  }
  if (isSessionShape(result)) return { kind: 'session', session: result };
  throw new AuthBridgeError(502, unexpected);
}

/**
 * The ONE thing an unauthenticated caller is ever told about a rejected
 * password. Deliberately says nothing about whether the address is registered.
 */
const GENERIC_LOGIN_FAILURE = 'Invalid email or password.';

/**
 * A rejection the user genuinely needs to read, and which cannot be an
 * enumeration oracle because the backend only reaches it AFTER the password
 * verified (`auth.service.validateUser`: the suspension check lives inside the
 * successful-compare branch). Matching on the wording is coupling we would
 * rather not have, but the backend signals this with a 401 and a string and
 * nothing else; the existing social-exchange bridge below already does the
 * same, so both paths follow one rule. Failing to match is SAFE — the message
 * simply collapses to the generic one.
 */
const POST_AUTHENTICATION_401 = /suspended/i;

/**
 * Sign in with a password.
 *
 * The backend's 401 body is NOT relayed verbatim (SPLIT-1420). As of this
 * writing it cannot leak anything — an unknown address and a wrong password
 * come out of the same `throw new UnauthorizedException('Invalid email or
 * password')`, with a dummy bcrypt compare equalising the timing — but this
 * page is unauthenticated, and a future backend wording change would silently
 * turn it into a user-enumeration oracle for every MCP client. So the oracle
 * is closed HERE, where the untrusted audience is, instead of being assumed
 * closed upstream.
 */
export async function backendLogin(email: string, password: string, ctx: ClientContext): Promise<LoginOutcome> {
  let result: unknown;
  try {
    result = await backendRequest('POST', '/users/login', {
      body: { email, password },
      headers: relayHeaders(ctx),
    });
  } catch (error) {
    const bridged = toBridgeError(error, 'Sign-in failed');
    if ((bridged.status === 401 || bridged.status === 403) && !POST_AUTHENTICATION_401.test(bridged.message)) {
      throw new AuthBridgeError(bridged.status, GENERIC_LOGIN_FAILURE);
    }
    throw bridged;
  }
  return toLoginOutcome(result, 'Unexpected response from Splitt sign-in');
}

/**
 * Which social providers the backend can serve on the web flow (public,
 * unauthenticated). Any failure, including the 3 s timeout, is read as "none
 * configured": the sign-in page then simply offers no social buttons, and the
 * password form keeps working.
 */
export async function backendSocialProviders(): Promise<SocialProvider[]> {
  try {
    const r = (await backendRequest('GET', '/auth/providers', { timeoutMs: PROVIDERS_TIMEOUT_MS })) as Record<string, unknown> | null;
    return SOCIAL_PROVIDERS.filter((p) => r?.[p] === true);
  } catch {
    return [];
  }
}

/**
 * Swap the one-time exchange code the backend's Google/Apple callback hands
 * the browser (`?code=...` on our return_to) for a session, or a 2FA challenge
 * when the account has two-step verification on. Unknown, replayed and
 * expired codes are one opaque 401 at the backend; a suspended account is a
 * 401 with its own message, which is kept because the user needs to read it.
 */
export async function backendExchangeSocialCode(code: string, ctx: ClientContext): Promise<LoginOutcome> {
  let result: unknown;
  try {
    result = await backendRequest('POST', '/auth/oauth/exchange', {
      body: { code },
      headers: relayHeaders(ctx),
    });
  } catch (error) {
    if (error instanceof BackendApiError && error.status === 401 && !/suspended/i.test(error.message)) {
      throw new AuthBridgeError(401, 'That sign-in link has expired or was already used. Please try again.');
    }
    if (error instanceof BackendApiError && error.status === 400) {
      throw new AuthBridgeError(400, 'That sign-in link is not valid. Please try again.');
    }
    throw toBridgeError(error, 'Sign-in failed');
  }
  return toLoginOutcome(result, 'Unexpected response from Splitt sign-in');
}

export async function backendSendOtp(challengeToken: string, ctx: ClientContext): Promise<{ maskedEmail?: string }> {
  try {
    const r = (await backendRequest('POST', '/auth/2fa/otp/send', {
      body: { challengeToken },
      headers: relayHeaders(ctx),
    })) as { maskedEmail?: string } | null;
    return { maskedEmail: r?.maskedEmail };
  } catch (error) {
    throw toBridgeError(error, 'Could not send the verification code');
  }
}

export async function backendVerifyOtp(challengeToken: string, code: string, ctx: ClientContext): Promise<BackendSession> {
  let result: unknown;
  try {
    result = await backendRequest('POST', '/auth/2fa/otp/verify', {
      body: { challengeToken, code },
      headers: relayHeaders(ctx),
    });
  } catch (error) {
    throw toBridgeError(error, 'Verification failed');
  }
  if (isSessionShape(result)) return result;
  throw new AuthBridgeError(502, 'Unexpected response from Splitt verification');
}

export interface RefreshedSession {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
}

export async function backendRefresh(refreshToken: string, ctx: ClientContext): Promise<RefreshedSession> {
  let result: unknown;
  try {
    result = await backendRequest('POST', '/auth/refresh', {
      body: { refreshToken },
      headers: relayHeaders(ctx),
    });
  } catch (error) {
    throw toBridgeError(error, 'Session refresh failed');
  }
  const r = result as Partial<RefreshedSession> | null;
  if (r && typeof r.accessToken === 'string' && typeof r.refreshToken === 'string') {
    return { accessToken: r.accessToken, refreshToken: r.refreshToken, expiresIn: typeof r.expiresIn === 'number' ? r.expiresIn : undefined };
  }
  throw new AuthBridgeError(502, 'Unexpected response from Splitt session refresh');
}

/** Best-effort revocation; RFC 7009 says the caller is told 200 regardless. */
export async function backendLogout(accessToken: string, refreshToken: string, ctx: ClientContext): Promise<boolean> {
  try {
    await backendRequest('POST', '/auth/logout', {
      token: accessToken,
      body: { refreshToken },
      headers: relayHeaders(ctx),
    });
    return true;
  } catch {
    return false;
  }
}
