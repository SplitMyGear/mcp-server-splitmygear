/**
 * Authorization endpoint logic (OAuth 2.1 authorization-code flow with PKCE),
 * kept free of Next.js so it is unit-testable with plain `Request`/`Response`.
 *
 * GET  /oauth/authorize?response_type=code&client_id&redirect_uri&state&code_challenge&code_challenge_method=S256[&resource][&scope]
 *      → validates the request; renders the hosted sign-in page with the
 *        validated request sealed into a short-lived `req` envelope. `scope`
 *        is RFC 6749 §3.3 space-separated (see lib/oauth/scopes); omitted =
 *        full access, and the consent card says so.
 * POST /oauth/authorize (form)
 *      step=login       email+password → backend login → code, or 2FA step
 *      step=otp         one-time code  → backend verify → code
 *      step=otp_resend  re-send the one-time code
 *      step=cancel      → redirect with error=access_denied
 * GET  /oauth/social/start?provider=google|apple&req=<req>
 *      → sends the browser to the backend's provider flow, to come back at
 * GET  /oauth/social/callback?req=<req>&code=<exchange code> | &error=<code>
 *      → swaps the code for a session and finishes like a password sign-in
 *        (see "Social sign-in" below).
 *
 * Error handling follows RFC 6749 §4.1.2.1: an invalid client_id / redirect_uri
 * is shown to the USER (never redirected, or the endpoint becomes an open
 * redirector); every other error is redirected to the registered redirect_uri
 * with `error` + `state`.
 */
import crypto from 'crypto';
import { backendBaseUrl } from '@/lib/backend-client';
import { resolveClient, clientAllowsRedirect, isVerifiedRedirectUri } from './client';
import { isValidCodeChallenge } from './pkce';
import { open, seal, nowSeconds } from './envelope';
import { issueAuthorizationCode } from './tokens';
import { resourceUrl, oauthEnabled, publicBaseUrl } from './config';
import {
  AuthBridgeError,
  backendExchangeSocialCode,
  backendLogin,
  backendSendOtp,
  backendSocialProviders,
  backendVerifyOtp,
  isSocialProvider,
  type BackendSession,
  type ClientContext,
  type LoginOutcome,
  type SocialProvider,
} from './backend-auth';
import { renderErrorPage, renderLoginPage, renderOtpPage, PAGE_HEADERS } from './pages';
import { coerceScopes, parseScopeParam, type ToolScope } from './scopes';
import { claimAttempt, refundAttempt } from './throttle';
import { clientIp, isSameOriginPost, readParams, type OAuthErrorCode } from './http';

/** How long a rendered sign-in page stays submittable. */
/** RFC 6749 leaves `state` unbounded; cap it so the sealed request (and the social return_to built from it) stays a sane size. */
const MAX_STATE_LENGTH = 512;
/** RFC 5321 mailbox limit; also bounds the throttle keys built from the address. */
const MAX_EMAIL_LENGTH = 254;
/** The backend's `oauth_exchange_code.returnTo` column width. */
const SOCIAL_RETURN_TO_MAX_LENGTH = 2048;
const REQUEST_TTL_S = 10 * 60;
const THROTTLED_MESSAGE = 'Too many sign-in attempts from your network. Please wait a few minutes and try again.';
const EXPIRED_MESSAGE = 'This sign-in page has expired. Go back to the application and connect again.';

export interface AuthorizeRequestPayload {
  cid: string;
  ru: string;
  st?: string;
  cc: string;
  res?: string;
  cn: string;
  /** Scopes the client asked for (all of them when it sent no `scope`). */
  sc: ToolScope[];
  /** Did the client name scopes explicitly? (false = it asked for full access) */
  sr: boolean;
  /** Social providers the backend offered when the page was rendered (one button each). */
  sp?: SocialProvider[];
  /** Social sign-in only: nonce tying this request to the browser that started it (see `handleSocialStartGet`). */
  sn?: string;
  exp: number;
  iat: number;
}

/** A request payload as passed around between renders (envelope timestamps are re-minted on every seal). */
type AuthorizeRequest = Omit<AuthorizeRequestPayload, 'exp' | 'iat'>;

interface ChallengePayload {
  ct: string;
  me: string;
  /** Lowercased account email, sealed (never rendered): the per-account throttle key. */
  em?: string;
  rq: AuthorizeRequest;
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

function sealRequest(rq: AuthorizeRequest): string {
  const iat = nowSeconds();
  return seal<AuthorizeRequestPayload>('req', { ...rq, iat, exp: iat + REQUEST_TTL_S });
}

function offeredProviders(rq: AuthorizeRequest): SocialProvider[] {
  return (rq.sp ?? []).filter(isSocialProvider);
}

function loginPage(rq: AuthorizeRequest, opts: { email?: string; error?: string } = {}, status = 200): Response {
  return html(
    renderLoginPage({
      requestToken: sealRequest(rq),
      clientName: rq.cn,
      redirectUri: rq.ru,
      verified: isVerifiedRedirectUri(rq.ru),
      scopes: coerceScopes(rq.sc),
      scopesRequested: rq.sr === true,
      providers: offeredProviders(rq),
      email: opts.email,
      error: opts.error,
    }),
    status,
  );
}

function otpPage(rq: AuthorizeRequest, challengeToken: string, maskedEmail: string, error?: string, email?: string): Response {
  const iat = nowSeconds();
  const chal = seal<ChallengePayload>('chal', { ct: challengeToken, me: maskedEmail, em: email, rq, iat, exp: iat + REQUEST_TTL_S });
  return html(renderOtpPage({ challengeToken: chal, maskedEmail, error }));
}

function successRedirect(rq: AuthorizeRequest, session: BackendSession): Response {
  const code = issueAuthorizationCode({
    clientId: rq.cid,
    redirectUri: rq.ru,
    codeChallenge: rq.cc,
    resource: rq.res,
    user: session.user,
    backendAccessToken: session.accessToken,
    backendRefreshToken: session.refreshToken,
    scopes: coerceScopes(rq.sc),
  });
  return redirectTo(rq.ru, { code, state: rq.st });
}

/**
 * Finish a sign-in from a backend outcome: a session becomes the code
 * redirect; a 2FA challenge triggers the email code (a cooldown error just
 * means one is already in flight) and renders the OTP step.
 */
async function completeLogin(rq: AuthorizeRequest, outcome: LoginOutcome, ctx: ClientContext, email?: string): Promise<Response> {
  if (outcome.kind === 'session') return successRedirect(rq, outcome.session);
  let masked = outcome.challenge.maskedEmail;
  try {
    const sent = await backendSendOtp(outcome.challenge.challengeToken, ctx);
    masked = sent.maskedEmail || masked;
  } catch {
    /* keep going: the user can press "Resend code" */
  }
  return otpPage(rq, outcome.challenge.challengeToken, masked, undefined, email);
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

function clientContext(request: Request): ClientContext {
  return { ip: clientIp(request), userAgent: request.headers.get('user-agent') ?? undefined };
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
  if (state !== undefined && state.length > MAX_STATE_LENGTH) {
    // Not echoed back: the whole point is that it is too long to carry around.
    return redirectError(redirectUri, 'invalid_request', `state must be at most ${MAX_STATE_LENGTH} characters`);
  }
  if (q('response_type') !== 'code') return redirectError(redirectUri, 'unsupported_response_type', 'response_type must be "code"', state);
  const codeChallenge = q('code_challenge');
  if (!isValidCodeChallenge(codeChallenge)) return redirectError(redirectUri, 'invalid_request', 'A PKCE code_challenge is required', state);
  if (q('code_challenge_method') !== 'S256') return redirectError(redirectUri, 'invalid_request', 'code_challenge_method must be S256', state);
  const resource = q('resource');
  if (resource !== undefined && resource !== resourceUrl(request)) {
    return redirectError(redirectUri, 'invalid_target', `resource must be ${resourceUrl(request)}`, state);
  }
  const scope = parseScopeParam(q('scope'));
  if (!scope.ok) return redirectError(redirectUri, 'invalid_scope', scope.error, state);

  // Which "Continue with ..." buttons to offer: asked once per sign-in and
  // carried in the sealed request, so re-renders after a failed attempt cost
  // no extra backend call. Unreachable backend = no buttons (3 s bound).
  const providers = await backendSocialProviders();

  return loginPage({
    cid: client.client_id,
    ru: redirectUri,
    st: state,
    cc: codeChallenge,
    res: resource,
    cn: client.client_name || 'An application',
    sc: scope.scopes,
    sr: scope.requested,
    sp: providers,
  });
}

/**
 * Throttle keys for a sign-in attempt, split by WHERE they are enforced.
 *
 * `gate` keys identify the CALLER (their IP, the social round-trip they
 * started). Only they can spend them, so refusing up front is safe.
 *
 * `deferred` keys identify the TARGET (the account being signed in to).
 * Anyone who knows an email address can spend one of these, so gating on them
 * up front is a targeted account-lockout DoS (CWE-645): ten wrong passwords
 * for victim@example.com and the real owner cannot sign in for ten minutes,
 * renewable forever. They are therefore claimed (so distributed guessing at a
 * single account is still counted and still capped) but only ENFORCED once the
 * backend has already rejected the credentials — a correct password returns
 * before the deferred budget is ever consulted, so the owner gets in no matter
 * how hard someone else has been guessing.
 *
 * This is the ordering the Splitt backend itself adopted in SPLIT-427: its
 * per-email lockout is evaluated only inside the failed-credential branch,
 * never ahead of it. The comment this replaces claimed to mirror that rule
 * while doing the opposite — checking the per-account counter BEFORE the
 * credential check, which is exactly the DoS SPLIT-427 removed.
 *
 * Trade-off, stated plainly: the per-account counter no longer keeps a
 * password-spray away from the backend, only from succeeding. The backend's
 * own per-IP (10) and per-email (15) throttles over the same ten-minute window
 * are the authoritative control, and they see the real caller's address
 * because we relay it (`MCP_BFF_RELAY_KEY`). Without a trusted IP the per-IP
 * key is skipped entirely; the backend still throttles our egress address.
 */
interface AttemptKeys {
  gate: string[];
  deferred: string[];
}

function throttleKeys(ip: string | undefined, account: string | undefined): AttemptKeys {
  return {
    gate: ip ? [`ip:${ip}`] : [],
    deferred: account ? [`email:${account.trim().toLowerCase()}`] : [],
  };
}

interface Attempt {
  /** false when the CALLER's own budget is spent: refuse before touching the backend. */
  allowed: boolean;
  /** true when the TARGET account's budget is spent — only meaningful once the credentials failed. */
  accountBudgetSpent: boolean;
  /** Hand every claimed slot back: this attempt was not a failure. Idempotent. */
  refund(): Promise<void>;
}

/**
 * Claim one slot on every key for this attempt, atomically (see throttle.ts:
  * the claim IS the check, so a concurrent burst cannot all read "under the
 * limit" and sail past the ceiling together).
 *
 * A refused attempt gives its slots straight back: being turned away is not a
 * failed guess, and letting refusals accumulate would let an attacker hold a
 * lockout open indefinitely.
 */
async function beginAttempt(keys: AttemptKeys): Promise<Attempt> {
  // One timestamp for the whole attempt so a claim and its refund always land
  // on the same fixed window, even across a window boundary mid-request.
  const now = Date.now();
  const claim = async (key: string) => ({ key, ok: await claimAttempt(key, now) });
  const [gate, deferred] = await Promise.all([
    Promise.all(keys.gate.map(claim)),
    Promise.all(keys.deferred.map(claim)),
  ]);

  let settled = false;
  const refund = async (): Promise<void> => {
    if (settled) return;
    settled = true;
    await Promise.all([...gate, ...deferred].map((c) => refundAttempt(c.key, now)));
  };

  const allowed = gate.every((c) => c.ok);
  if (!allowed) await refund();
  return { allowed, accountBudgetSpent: deferred.some((c) => !c.ok), refund };
}

export async function handleAuthorizePost(request: Request): Promise<Response> {
  if (!oauthEnabled()) return html(renderErrorPage('Sign-in unavailable', 'OAuth sign-in is not enabled on this server.'), 404);
  if (!isSameOriginPost(request)) {
    return html(renderErrorPage('Blocked', 'This sign-in form can only be submitted from the Splitt sign-in page itself.'), 403);
  }
  const params = await readParams(request);
  const ctx = clientContext(request);
  const step = params.step;

  if (step === 'login' || step === 'cancel') {
    const rq = open<AuthorizeRequestPayload>('req', params.req);
    if (!rq) return html(renderErrorPage('Sign-in expired', EXPIRED_MESSAGE), 400);
    if (step === 'cancel') return redirectError(rq.ru, 'access_denied', 'The user cancelled sign-in', rq.st);

    const email = (params.email || '').trim();
    const password = params.password || '';
    if (!email || !password) return loginPage(rq, { email, error: 'Enter your email and password.' }, 400);
    if (email.length > MAX_EMAIL_LENGTH) return loginPage(rq, { email: '', error: 'Enter a valid email address.' }, 400);
    const attempt = await beginAttempt(throttleKeys(ctx.ip, email));
    if (!attempt.allowed) return loginPage(rq, { email, error: THROTTLED_MESSAGE }, 429);

    try {
      const outcome = await backendLogin(email, password, ctx);
      // The credentials were accepted (session or 2FA challenge): give the
      // slots back so a real sign-in never spends the failure budget.
      await attempt.refund();
      return await completeLogin(rq, outcome, ctx, email.toLowerCase());
    } catch (error) {
      // A rejected attempt keeps its claims: they ARE the failure record. Only
      // now does the targeted account's budget apply (see throttleKeys).
      if (attempt.accountBudgetSpent) return loginPage(rq, { email, error: THROTTLED_MESSAGE }, 429);
      return loginPage(rq, { email, error: bridgeErrorMessage(error, 'Sign-in failed. Please try again.') }, pageStatusFor(error));
    }
  }

  if (step === 'otp' || step === 'otp_resend') {
    const chal = open<ChallengePayload>('chal', params.chal);
    if (!chal) return html(renderErrorPage('Verification expired', 'This verification step has expired. Go back to the application and connect again.'), 400);
    const attempt = await beginAttempt(throttleKeys(ctx.ip, chal.em ?? chal.me));
    if (!attempt.allowed) return otpPage(chal.rq, chal.ct, chal.me, THROTTLED_MESSAGE, chal.em);

    if (step === 'otp_resend') {
      // Asking for a new code is not a guess, so it never spends the failure
      // budget (the backend caps resends itself). The claim above was only how
      // the gate is read atomically; hand it straight back.
      await attempt.refund();
      try {
        const sent = await backendSendOtp(chal.ct, ctx);
        return otpPage(chal.rq, chal.ct, sent.maskedEmail || chal.me, 'A new code is on its way.', chal.em);
      } catch (error) {
        return otpPage(chal.rq, chal.ct, chal.me, bridgeErrorMessage(error, 'Could not resend the code.'), chal.em);
      }
    }

    const code = (params.code || '').trim();
    if (!code) {
      await attempt.refund(); // nothing was tried
      return otpPage(chal.rq, chal.ct, chal.me, 'Enter the code from your email.', chal.em);
    }
    try {
      const session = await backendVerifyOtp(chal.ct, code, ctx);
      await attempt.refund();
      return successRedirect(chal.rq, session);
    } catch (error) {
      if (error instanceof AuthBridgeError && error.status === 401) {
        // Challenge consumed/expired → start over with the original request intact.
        return loginPage(chal.rq, { error: 'That verification session has expired. Please sign in again.' }, 401);
      }
      if (attempt.accountBudgetSpent) return otpPage(chal.rq, chal.ct, chal.me, THROTTLED_MESSAGE, chal.em);
      return otpPage(chal.rq, chal.ct, chal.me, bridgeErrorMessage(error, 'Verification failed.'), chal.em);
    }
  }

  return html(renderErrorPage('Invalid request', 'Unrecognised sign-in step.'), 400);
}

/*
 * Social sign-in ("Continue with Google / Apple")
 * ------------------------------------------------
 * The page links to /oauth/social/start, which sends the browser to the
 * backend's own provider flow with
 *   return_to = <this server>/oauth/social/callback?req=<sealed request>
 * The backend allow-lists return_to by ORIGIN, runs the provider round-trip,
 * and redirects the browser to return_to with ?code=<one-time exchange code>
 * (or ?error=<code>). The callback swaps the code for a session and then does
 * exactly what a password sign-in does: same scopes, same code, same redirect.
 *
 * What protects the consent step. With the password form the user proves
 * consent by typing credentials on OUR page, which names the app and its
 * redirect address. A social round-trip has no such moment: whoever gets a
 * browser to the backend's /auth/google with a return_to that names OUR
 * callback and THEIR sealed request would get an authorization code for the
 * signed-in victim delivered to their own redirect_uri without the victim
 * ever seeing the consent card (the backend allow-lists the return_to origin,
 * not the request inside it). So the start leg only accepts a same-origin
 * navigation (a click on our page, where the consent card is), and it binds
 * that browser to the round-trip: a random nonce goes into the re-sealed
 * request AND into a short-lived HttpOnly cookie, and the callback requires
 * both to match. A deep link straight to the backend cannot set our cookie;
 * a deep link to /start is refused as cross-site. The exchange code itself is
 * single-use and expires in a minute at the backend, so a callback URL that
 * leaks (history, logs) is worthless afterwards.
 *
 * No same-origin check applies to the CALLBACK: it is a top-level navigation
 * from the backend, i.e. cross-site by construction. The nonce cookie above
 * (SameSite=Lax cookies travel on top-level GET navigations) plus the sealed
 * request and the single-use code are the protection there.
 */
const SOCIAL_COOKIE = 'smg_social';
const SOCIAL_COOKIE_PATH = '/oauth/social/callback';
/** The backend's exchange code is 32 random bytes hex-encoded; its DTO accepts 32 to 128 chars. */
const EXCHANGE_CODE_PATTERN = /^[A-Za-z0-9._~-]{32,128}$/;

const SOCIAL_ERROR_MESSAGES: Record<string, { message: string; status: number }> = {
  google_auth_failed: { message: 'Google sign-in did not complete. Please try again, or sign in with your email and password.', status: 400 },
  apple_auth_failed: { message: 'Apple sign-in did not complete. Please try again, or sign in with your email and password.', status: 400 },
  invalid_state: { message: 'That sign-in attempt has expired or was already used. Please try again.', status: 400 },
  email_not_verified: {
    message: 'The email address on that account is not verified with the provider, so Splitt cannot sign you in with it. Verify it there first, or sign in with your email and password.',
    status: 400,
  },
  user_cancelled: { message: 'You cancelled the sign-in. You can try again, or sign in with your email and password.', status: 200 },
  google_not_configured: { message: 'Sign-in with Google is not available right now. Please sign in with your email and password.', status: 503 },
  apple_not_configured: { message: 'Sign-in with Apple is not available right now. Please sign in with your email and password.', status: 503 },
};
const SOCIAL_ERROR_FALLBACK = { message: 'Social sign-in did not complete. Please try again, or sign in with your email and password.', status: 400 };

/**
 * Over https the cookie carries the `__Host-` prefix: browsers then refuse to
 * accept it from any other host (no sibling-subdomain "cookie tossing"), which
 * requires `Secure`, `Path=/` and no `Domain`. Plain http (local dev) cannot
 * use the prefix, so it falls back to the bare name scoped to the callback path.
 */
function isSecureOrigin(request: Request): boolean {
  return publicBaseUrl(request).startsWith('https://');
}
function socialCookieName(request: Request): string {
  return isSecureOrigin(request) ? `__Host-${SOCIAL_COOKIE}` : SOCIAL_COOKIE;
}
function socialCookie(value: string, maxAge: number, request: Request): string {
  if (isSecureOrigin(request)) {
    return `${socialCookieName(request)}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax; Secure`;
  }
  return `${SOCIAL_COOKIE}=${value}; Path=${SOCIAL_COOKIE_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`;
}

function cookieValue(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * Constant-time nonce comparison.
 *
 * The length guard has to be on the BYTES, not on `String.length`: the cookie
 * value is attacker-supplied and `String.length` counts UTF-16 code units,
 * so `'é'` (1 unit, 2 bytes) passes a length check against `'a'` (1 unit,
 * 1 byte) and `timingSafeEqual` then THROWS on the mismatched buffers —
 * an unhandled 500 on the callback, reachable by anyone who can set a cookie.
 * Encode first, compare the buffer lengths, and only then compare in constant
 * time. (Buffer.from defaults to utf8; it is spelled out here because this is
 * exactly the assumption that was wrong.)
 */
function nonceMatches(cookie: string | undefined, expected: string | undefined): boolean {
  if (!cookie || !expected) return false;
  const actual = Buffer.from(cookie, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  if (actual.length !== wanted.length) return false;
  return crypto.timingSafeEqual(actual, wanted);
}

/** The request without its social binding: what later renders and the code issuance work from. */
function unbound(rq: AuthorizeRequest): AuthorizeRequest {
  const copy: AuthorizeRequest & { sn?: string; exp?: number; iat?: number } = { ...rq };
  delete copy.sn;
  delete copy.exp;
  delete copy.iat;
  return copy;
}

/** The nonce cookie is single-use: every callback response tells the browser to drop it. */
function clearingSocialCookie(response: Response, request: Request): Response {
  response.headers.append('Set-Cookie', socialCookie('', 0, request));
  return response;
}

export async function handleSocialStartGet(request: Request): Promise<Response> {
  if (!oauthEnabled()) return html(renderErrorPage('Sign-in unavailable', 'OAuth sign-in is not enabled on this server.'), 404);
  // Only a link on our own sign-in page may start a social sign-in (see the
  // note above): browsers set Sec-Fetch-Site on every navigation and page
  // script cannot forge it. `cross-site` is a link elsewhere, `none` a typed
  // or mailed URL; neither showed the consent card. Fails closed when absent.
  if (request.headers.get('sec-fetch-site') !== 'same-origin') {
    return html(
      renderErrorPage(
        'Blocked',
        'Social sign-in can only be started from the Splitt sign-in page. Go back to the application, connect again and use the "Continue with Google" or "Continue with Apple" button there, or sign in with your email and password.',
      ),
      403,
    );
  }
  const url = new URL(request.url);
  const provider = url.searchParams.get('provider');
  if (!isSocialProvider(provider)) return html(renderErrorPage('Invalid request', 'Unknown sign-in provider.'), 400);
  const rq = open<AuthorizeRequestPayload>('req', url.searchParams.get('req'));
  if (!rq) return html(renderErrorPage('Sign-in expired', EXPIRED_MESSAGE), 400);

  const nonce = crypto.randomBytes(16).toString('base64url');
  const bound = sealRequest({ ...unbound(rq), sn: nonce });
  const returnTo = `${publicBaseUrl(request)}/oauth/social/callback?req=${encodeURIComponent(bound)}`;
  if (returnTo.length > SOCIAL_RETURN_TO_MAX_LENGTH) {
    // The backend caps return_to at the width of its state column and would
    // bounce the user to the Splitt web login instead of back here.
    return html(
      renderErrorPage(
        'Sign-in request too large',
        'This app\'s sign-in request is too long for social sign-in (its redirect address or state is unusually large). Sign in with your email and password instead, or ask the app to shorten its request.',
      ),
      400,
    );
  }
  const location = `${backendBaseUrl()}/auth/${provider}?return_to=${encodeURIComponent(returnTo)}`;
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      'Cache-Control': 'no-store',
      'Set-Cookie': socialCookie(nonce, REQUEST_TTL_S, request),
    },
  });
}

export async function handleSocialCallbackGet(request: Request): Promise<Response> {
  if (!oauthEnabled()) return html(renderErrorPage('Sign-in unavailable', 'OAuth sign-in is not enabled on this server.'), 404);
  const url = new URL(request.url);
  const q = (name: string) => url.searchParams.get(name) ?? undefined;
  const done = (response: Response) => clearingSocialCookie(response, request);

  const bound = open<AuthorizeRequestPayload>('req', q('req'));
  if (!bound) return done(html(renderErrorPage('Sign-in expired', EXPIRED_MESSAGE), 400));
  if (!nonceMatches(cookieValue(request, socialCookieName(request)), bound.sn)) {
    return done(
      html(
        renderErrorPage(
          'Sign-in could not be completed',
          'This sign-in did not start from the Splitt sign-in page, or your browser did not keep the cookie that ties the two steps together. Go back to the application, connect again and start from the sign-in page, or sign in with your email and password.',
        ),
        400,
      ),
    );
  }
  const rq = unbound(bound);
  const ctx = clientContext(request);

  const error = q('error');
  const code = q('code');
  if (error !== undefined || !code) {
    // Own-property lookup only: `?error=constructor` must not find Object.prototype.
    const known = error !== undefined && Object.hasOwn(SOCIAL_ERROR_MESSAGES, error) ? SOCIAL_ERROR_MESSAGES[error] : undefined;
    const { message, status } = known ?? SOCIAL_ERROR_FALLBACK;
    return done(loginPage(rq, { error: message }, status));
  }

  // Per IP and per started sign-in (the nonce): a leaked callback URL cannot be
  // hammered with guesses. Both identify the CALLER — only whoever started this
  // round-trip can spend them — so both gate the attempt up front. There is no
  // account key here, and so nothing a stranger could spend on a victim's
  // behalf (see throttleKeys).
  const base = throttleKeys(ctx.ip, undefined);
  const attempt = await beginAttempt({ gate: [...base.gate, `social:${bound.sn}`], deferred: base.deferred });
  if (!attempt.allowed) return done(loginPage(rq, { error: THROTTLED_MESSAGE }, 429));
  // Claims below are KEPT: a malformed or rejected exchange code is a failure.
  if (!EXCHANGE_CODE_PATTERN.test(code)) {
    return done(loginPage(rq, { error: 'That sign-in link is not valid. Please try again.' }, 400));
  }

  try {
    const outcome = await backendExchangeSocialCode(code, ctx);
    await attempt.refund();
    return done(await completeLogin(rq, outcome, ctx));
  } catch (err) {
    return done(loginPage(rq, { error: bridgeErrorMessage(err, 'Sign-in failed. Please try again.') }, pageStatusFor(err)));
  }
}
