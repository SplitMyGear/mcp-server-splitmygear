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

/** A user-safe failure from the backend auth endpoints. */
export class AuthBridgeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'AuthBridgeError';
    this.status = status;
  }
}

function relayHeaders(ctx: ClientContext): Record<string, string> {
  const headers: Record<string, string> = {};
  const relayKey = process.env.MCP_BFF_RELAY_KEY;
  if (relayKey && ctx.ip) {
    headers['x-smg-relay-key'] = relayKey;
    headers['x-smg-client-ip'] = ctx.ip;
  }
  headers['User-Agent'] = ctx.userAgent ? `${ctx.userAgent} (via splitt-mcp)` : 'splitt-mcp';
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

export async function backendLogin(email: string, password: string, ctx: ClientContext): Promise<LoginOutcome> {
  let result: unknown;
  try {
    result = await backendRequest('POST', '/users/login', {
      body: { email, password },
      headers: relayHeaders(ctx),
    });
  } catch (error) {
    throw toBridgeError(error, 'Sign-in failed');
  }
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
  throw new AuthBridgeError(502, 'Unexpected response from Splitt sign-in');
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
