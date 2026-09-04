/**
 * Authorization endpoint logic (OAuth 2.1 authorization-code flow with PKCE),
 * kept free of Next.js so it is unit-testable with plain `Request`/`Response`.
 *
 * GET  /oauth/authorize?response_type=code&client_id&redirect_uri&state&code_challenge&code_challenge_method=S256[&resource]
 *      → validates the request; renders the hosted sign-in page with the
 *        validated request sealed into a short-lived `req` envelope.
 * POST /oauth/authorize (form)
 *      step=login       email+password → backend login → code, or 2FA step
 *      step=otp         one-time code  → backend verify → code
 *      step=otp_resend  re-send the one-time code
 *      step=cancel      → redirect with error=access_denied
 *
 * Error handling follows RFC 6749 §4.1.2.1: an invalid client_id / redirect_uri
 * is shown to the USER (never redirected, or the endpoint becomes an open
 * redirector); every other error is redirected to the registered redirect_uri
 * with `error` + `state`.
 */
import { resolveClient, clientAllowsRedirect, isVerifiedRedirectUri } from './client';
import { isValidCodeChallenge } from './pkce';
import { open, seal, nowSeconds } from './envelope';
import { issueAuthorizationCode } from './tokens';
import { resourceUrl, oauthEnabled } from './config';
import { AuthBridgeError, backendLogin, backendSendOtp, backendVerifyOtp, type ClientContext } from './backend-auth';
import { renderErrorPage, renderLoginPage, renderOtpPage, PAGE_HEADERS } from './pages';
import { isThrottled, recordAttempt } from './throttle';
import { clientIp, isSameOriginPost, readParams, type OAuthErrorCode } from './http';

/** How long a rendered sign-in page stays submittable. */
const REQUEST_TTL_S = 10 * 60;
const THROTTLED_MESSAGE = 'Too many sign-in attempts from your network. Please wait a few minutes and try again.';

export interface AuthorizeRequestPayload {
  cid: string;
  ru: string;
  st?: string;
  cc: string;
  res?: string;
  cn: string;
  exp: number;
  iat: number;
}

interface ChallengePayload {
  ct: string;
  me: string;
  rq: Omit<AuthorizeRequestPayload, 'exp' | 'iat'>;
  exp: number;
  iat: number;
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: PAGE_HEADERS });
}

function redirectTo(base: string, params: Record<string, string | undefined>): Response {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { Location: url.toString(), 'Cache-Control': 'no-store' } });
}

function redirectError(ru: string, error: OAuthErrorCode, description: string, state?: string): Response {
  return redirectTo(ru, { error, error_description: description, state });
}

function sealRequest(rq: Omit<AuthorizeRequestPayload, 'exp' | 'iat'>): string {
  const iat = nowSeconds();
  return seal<AuthorizeRequestPayload>('req', { ...rq, iat, exp: iat + REQUEST_TTL_S });
}

function loginPage(rq: Omit<AuthorizeRequestPayload, 'exp' | 'iat'>, opts: { email?: string; error?: string } = {}, status = 200): Response {
  return html(
    renderLoginPage({
      requestToken: sealRequest(rq),
      clientName: rq.cn,
      redirectUri: rq.ru,
      verified: isVerifiedRedirectUri(rq.ru),
      email: opts.email,
      error: opts.error,
    }),
    status,
  );
}

function otpPage(rq: Omit<AuthorizeRequestPayload, 'exp' | 'iat'>, challengeToken: string, maskedEmail: string, error?: string): Response {
  const iat = nowSeconds();
  const chal = seal<ChallengePayload>('chal', { ct: challengeToken, me: maskedEmail, rq, iat, exp: iat + REQUEST_TTL_S });
  return html(renderOtpPage({ challengeToken: chal, maskedEmail, error }));
}

function successRedirect(rq: Omit<AuthorizeRequestPayload, 'exp' | 'iat'>, session: { accessToken: string; refreshToken: string; user: { id: string; email: string; role: string } }): Response {
  const code = issueAuthorizationCode({
    clientId: rq.cid,
    redirectUri: rq.ru,
    codeChallenge: rq.cc,
    resource: rq.res,
    user: session.user,
    backendAccessToken: session.accessToken,
    backendRefreshToken: session.refreshToken,
  });
  return redirectTo(rq.ru, { code, state: rq.st });
}

/** HTTP status for a re-rendered sign-in page: 401 bad credentials, 429 throttled, 503 backend trouble. */
function pageStatusFor(error: unknown): number {
  if (error instanceof AuthBridgeError) {
    if (error.status === 401 || error.status === 403) return 401;
    if (error.status === 429) return 429;
    if (error.status === 400) return 400;
  }
  return 503;
}

function bridgeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof AuthBridgeError) return error.message;
  return fallback;
}

export async function handleAuthorizeGet(request: Request): Promise<Response> {
  if (!oauthEnabled()) return html(renderErrorPage('Sign-in unavailable', 'OAuth sign-in is not enabled on this server.'), 404);
  const url = new URL(request.url);
  const q = (name: string) => url.searchParams.get(name) ?? undefined;

  const client = resolveClient(q('client_id'));
  if (!client) return html(renderErrorPage('Unknown application', 'The application requesting access is not registered with Splitt.'), 400);
  const redirectUri = q('redirect_uri');
  if (!redirectUri || !clientAllowsRedirect(client, redirectUri)) {
    return html(renderErrorPage('Invalid redirect', 'The application supplied a redirect address it did not register.'), 400);
  }
  const state = q('state');
  if (q('response_type') !== 'code') return redirectError(redirectUri, 'unsupported_response_type', 'response_type must be "code"', state);
  const codeChallenge = q('code_challenge');
  if (!isValidCodeChallenge(codeChallenge)) return redirectError(redirectUri, 'invalid_request', 'A PKCE code_challenge is required', state);
  if (q('code_challenge_method') !== 'S256') return redirectError(redirectUri, 'invalid_request', 'code_challenge_method must be S256', state);
  const resource = q('resource');
  if (resource !== undefined && resource !== resourceUrl(request)) {
    return redirectError(redirectUri, 'invalid_target', `resource must be ${resourceUrl(request)}`, state);
  }

  return loginPage({
    cid: client.client_id,
    ru: redirectUri,
    st: state,
    cc: codeChallenge,
    res: resource,
    cn: client.client_name || 'An application',
  });
}

/**
 * Throttle keys for a sign-in attempt: the caller's (trusted) IP and the
 * targeted account. Only FAILURES are recorded, so a legitimate owner is never
 * locked out by someone else's guesses (mirrors the backend's SPLIT-427 rule),
 * and nothing is cleared on success (a valid login must not reset the budget
 * for guesses at other accounts). Without a trusted IP the per-IP key is
 * skipped: the backend's own per-IP throttle still applies to our address.
 */
function throttleKeys(ip: string | undefined, email: string | undefined): string[] {
  const keys: string[] = [];
  if (ip) keys.push(`ip:${ip}`);
  if (email) keys.push(`email:${email.trim().toLowerCase()}`);
  return keys;
}
function anyThrottled(keys: string[]): boolean {
  return keys.some((k) => isThrottled(k));
}
function recordFailure(keys: string[]): void {
  for (const k of keys) recordAttempt(k);
}

export async function handleAuthorizePost(request: Request): Promise<Response> {
  if (!oauthEnabled()) return html(renderErrorPage('Sign-in unavailable', 'OAuth sign-in is not enabled on this server.'), 404);
  if (!isSameOriginPost(request)) {
    return html(renderErrorPage('Blocked', 'This sign-in form can only be submitted from the Splitt sign-in page itself.'), 403);
  }
  const params = await readParams(request);
  const ctx: ClientContext = { ip: clientIp(request), userAgent: request.headers.get('user-agent') ?? undefined };
  const step = params.step;

  if (step === 'login' || step === 'cancel') {
    const rq = open<AuthorizeRequestPayload>('req', params.req);
    if (!rq) return html(renderErrorPage('Sign-in expired', 'This sign-in page has expired. Go back to the application and connect again.'), 400);
    if (step === 'cancel') return redirectError(rq.ru, 'access_denied', 'The user cancelled sign-in', rq.st);

    const email = (params.email || '').trim();
    const password = params.password || '';
    if (!email || !password) return loginPage(rq, { email, error: 'Enter your email and password.' }, 400);
    const keys = throttleKeys(ctx.ip, email);
    if (anyThrottled(keys)) return loginPage(rq, { email, error: THROTTLED_MESSAGE }, 429);

    try {
      const outcome = await backendLogin(email, password, ctx);
      if (outcome.kind === 'session') return successRedirect(rq, outcome.session);
      // 2FA: trigger the email code (a cooldown error just means one is already in flight).
      let masked = outcome.challenge.maskedEmail;
      try {
        const sent = await backendSendOtp(outcome.challenge.challengeToken, ctx);
        masked = sent.maskedEmail || masked;
      } catch {
        /* keep going: the user can press "Resend code" */
      }
      return otpPage(rq, outcome.challenge.challengeToken, masked);
    } catch (error) {
      recordFailure(keys);
      return loginPage(rq, { email, error: bridgeErrorMessage(error, 'Sign-in failed. Please try again.') }, pageStatusFor(error));
    }
  }

  if (step === 'otp' || step === 'otp_resend') {
    const chal = open<ChallengePayload>('chal', params.chal);
    if (!chal) return html(renderErrorPage('Verification expired', 'This verification step has expired. Go back to the application and connect again.'), 400);
    const keys = throttleKeys(ctx.ip, chal.me);
    if (anyThrottled(keys)) return otpPage(chal.rq, chal.ct, chal.me, THROTTLED_MESSAGE);

    if (step === 'otp_resend') {
      try {
        const sent = await backendSendOtp(chal.ct, ctx);
        return otpPage(chal.rq, chal.ct, sent.maskedEmail || chal.me, 'A new code is on its way.');
      } catch (error) {
        return otpPage(chal.rq, chal.ct, chal.me, bridgeErrorMessage(error, 'Could not resend the code.'));
      }
    }

    const code = (params.code || '').trim();
    if (!code) return otpPage(chal.rq, chal.ct, chal.me, 'Enter the code from your email.');
    try {
      const session = await backendVerifyOtp(chal.ct, code, ctx);
      return successRedirect(chal.rq, session);
    } catch (error) {
      recordFailure(keys);
      if (error instanceof AuthBridgeError && error.status === 401) {
        // Challenge consumed/expired → start over with the original request intact.
        return loginPage(chal.rq, { error: 'That verification session has expired. Please sign in again.' }, 401);
      }
      return otpPage(chal.rq, chal.ct, chal.me, bridgeErrorMessage(error, 'Verification failed.'));
    }
  }

  return html(renderErrorPage('Invalid request', 'Unrecognised sign-in step.'), 400);
}
