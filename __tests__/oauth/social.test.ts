/**
 * "Continue with Google / Apple" on the hosted sign-in page, end to end
 * against a mocked backend: the start leg (browser sent to the backend with a
 * return_to at our callback, bound to the browser by a nonce cookie), the
 * return leg (one-time exchange code -> session -> authorization code ->
 * client redirect, or the 2FA step) and every way it can go wrong.
 * Exercises the real route handlers.
 */
export {};
import crypto from 'crypto';

const mockBackendRequest = jest.fn();
jest.mock('../../src/lib/backend-client', () => {
  class BackendApiError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.name = 'BackendApiError'; this.status = status; }
  }
  return { BackendApiError, backendRequest: (...args: unknown[]) => mockBackendRequest(...args), backendBaseUrl: () => 'http://backend.test/api/v1' };
});

import { POST as register } from '../../src/app/oauth/register/route';
import { GET as authorizeGet, POST as authorizePost } from '../../src/app/oauth/authorize/route';
import { GET as socialStart } from '../../src/app/oauth/social/start/route';
import { GET as socialCallback } from '../../src/app/oauth/social/callback/route';
import { POST as tokenPost } from '../../src/app/oauth/token/route';
import { seal } from '../../src/lib/oauth/envelope';
import { _resetThrottle } from '../../src/lib/oauth/throttle';

const KEY = 'unit-test-signing-key-with-at-least-32-bytes!!';
const BASE = 'https://mcp.test';
const BACKEND = 'http://backend.test/api/v1';
const REDIRECT = 'https://client.example/callback';
const EXCHANGE_CODE = 'e'.repeat(64);
const IP = '203.0.113.9';

function backendJwt(payload: Record<string, unknown>): string {
  const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg(payload)}.sig`;
}
const FUTURE = Math.floor(Date.now() / 1000) + 900;
const backendAccess = backendJwt({ sub: 'user-1', email: 'r@x.test', role: 'renter', exp: FUTURE });
const SESSION = { accessToken: backendAccess, refreshToken: 'brt-1', user: { id: 'user-1', email: 'r@x.test', role: 'renter' } };

const { BackendApiError } = jest.requireMock('../../src/lib/backend-client');

async function registerClient(): Promise<string> {
  const res = await register(new Request(`${BASE}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Test Client', redirect_uris: [REDIRECT] }) }));
  expect(res.status).toBe(201);
  return (await res.json()).client_id;
}
function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
function hidden(html: string, name: string): string {
  const m = html.match(new RegExp(`name="${name}" value="([^"]+)"`));
  if (!m) throw new Error(`hidden field ${name} not found`);
  return m[1].replace(/&amp;/g, '&');
}
/** The href of the "Continue with <provider>" link, HTML-unescaped. */
function socialHref(html: string, provider: string): string {
  const m = html.match(new RegExp(`href="(/oauth/social/start\\?provider=${provider}&amp;req=[^"]+)"`));
  if (!m) throw new Error(`no ${provider} link`);
  return m[1].replace(/&amp;/g, '&');
}
/** Render the sign-in page (providers: google + apple) and return what the tests need from it. */
async function signInPage(scope?: string) {
  const clientId = await registerClient();
  const { verifier, challenge } = pkce();
  mockBackendRequest.mockImplementation(async (method: string, path: string) => {
    if (method === 'GET' && path === '/auth/providers') return { google: true, apple: true };
    throw new Error(`unexpected ${method} ${path}`);
  });
  const u = new URL(`${BASE}/oauth/authorize`);
  for (const [k, v] of Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 'st-1', code_challenge: challenge, code_challenge_method: 'S256', ...(scope ? { scope } : {}) })) u.searchParams.set(k, v);
  const res = await authorizeGet(new Request(u.toString()));
  expect(res.status).toBe(200);
  const html = await res.text();
  mockBackendRequest.mockClear(); // the providers lookup is not part of what the tests below count
  return { clientId, verifier, html, req: hidden(html, 'req') };
}
/** A same-origin click on our page. */
function startRequest(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, { headers: { 'sec-fetch-site': 'same-origin', 'x-real-ip': IP, ...headers } });
}
function cookieOf(res: Response): { header: string; value: string } {
  const header = res.headers.get('set-cookie') || '';
  // Over https the cookie carries the __Host- prefix (and therefore Path=/).
  const m = header.match(/^(?:__Host-)?smg_social=([^;]*)/);
  if (!m) throw new Error(`no smg_social cookie in ${header}`);
  return { header, value: m[1] };
}
/** Start the round-trip for `provider`; returns the backend redirect pieces. */
async function start(req: string, provider = 'google') {
  const res = await socialStart(startRequest(`/oauth/social/start?provider=${provider}&req=${encodeURIComponent(req)}`));
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get('location')!);
  const returnTo = location.searchParams.get('return_to')!;
  return { res, location, returnTo, cookie: cookieOf(res).value };
}
/** What the backend does at the end of the provider round-trip: set code/error on return_to and send the browser there. */
function callbackRequest(returnTo: string, params: Record<string, string>, cookie?: string, headers: Record<string, string> = {}): Request {
  const url = new URL(returnTo);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url.toString(), { headers: { 'sec-fetch-site': 'cross-site', 'x-real-ip': IP, 'user-agent': 'TestBrowser/1', ...(cookie !== undefined ? { cookie: `__Host-smg_social=${cookie}` } : {}), ...headers } });
}
function form(body: Record<string, string>, url: string): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE, 'sec-fetch-site': 'same-origin', 'x-real-ip': IP },
    body: new URLSearchParams(body).toString(),
  });
}
function exchangeMock(handler: (opts: any) => unknown) {
  mockBackendRequest.mockImplementation(async (method: string, path: string, opts: any) => {
    if (method === 'POST' && path === '/auth/oauth/exchange') return handler(opts);
    throw new Error(`unexpected ${method} ${path}`);
  });
}

describe('social sign-in on the hosted page', () => {
  beforeEach(() => {
    process.env.MCP_OAUTH_SIGNING_KEY = KEY;
    process.env.MCP_PUBLIC_URL = BASE;
    process.env.MCP_BFF_RELAY_KEY = 'relay-secret';
    process.env.MCP_TRUST_PROXY_HEADERS = '1';
    _resetThrottle();
    mockBackendRequest.mockReset();
  });
  afterEach(() => {
    delete process.env.MCP_OAUTH_SIGNING_KEY;
    delete process.env.MCP_PUBLIC_URL;
    delete process.env.MCP_BFF_RELAY_KEY;
    delete process.env.MCP_TRUST_PROXY_HEADERS;
  });

  describe('start leg', () => {
    it('sends the browser to the backend provider flow with a return_to at our callback and binds the browser with a nonce cookie', async () => {
      const { req, html } = await signInPage();
      // The page links carry the very request the password form posts.
      expect(socialHref(html, 'google')).toBe(`/oauth/social/start?provider=google&req=${encodeURIComponent(req)}`);
      const { res, location, returnTo, cookie } = await start(req, 'google');

      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(location.origin + location.pathname).toBe(`${BACKEND}/auth/google`);
      expect([...location.searchParams.keys()]).toEqual(['return_to']);
      const rt = new URL(returnTo);
      expect(rt.origin + rt.pathname).toBe(`${BASE}/oauth/social/callback`);
      expect([...rt.searchParams.keys()]).toEqual(['req']);
      const bound = rt.searchParams.get('req')!;
      expect(bound.startsWith('smg_rq.')).toBe(true);
      expect(bound).not.toBe(req); // re-sealed with the nonce inside

      const { header } = cookieOf(res);
      expect(cookie).toMatch(/^[A-Za-z0-9_-]{20,}$/);
      // __Host- prefix: Secure, Path=/, no Domain (browsers refuse it from any other host).
      expect(header).toMatch(/^__Host-smg_social=/);
      expect(header).toContain('Path=/');
      expect(header).toContain('Secure');
      expect(header).not.toContain('Domain=');
      expect(header).toContain('HttpOnly');
      expect(header).toContain('SameSite=Lax');
      expect(header).toContain('Secure');
      expect(header).toMatch(/Max-Age=600/);

      const apple = await start(req, 'apple');
      expect(apple.location.origin + apple.location.pathname).toBe(`${BACKEND}/auth/apple`);
      expect(apple.cookie).not.toBe(cookie); // fresh nonce per start
    });

    it('omits the Secure flag on a plain-http (local dev) origin', async () => {
      process.env.MCP_PUBLIC_URL = 'http://localhost:3000';
      const { req } = await signInPage();
      const res = await socialStart(new Request(`http://localhost:3000/oauth/social/start?provider=google&req=${encodeURIComponent(req)}`, { headers: { 'sec-fetch-site': 'same-origin' } }));
      expect(res.status).toBe(302);
      expect(cookieOf(res).header).not.toContain('Secure');
      expect(new URL(new URL(res.headers.get('location')!).searchParams.get('return_to')!).origin).toBe('http://localhost:3000');
    });

    it('refuses an unknown provider, a bogus or expired request, and a start that is not a click on our own page', async () => {
      const { req } = await signInPage();
      const bad = await socialStart(startRequest(`/oauth/social/start?provider=facebook&req=${encodeURIComponent(req)}`));
      expect(bad.status).toBe(400);
      expect(await bad.text()).toContain('Unknown sign-in provider');
      expect((await socialStart(startRequest(`/oauth/social/start?req=${encodeURIComponent(req)}`))).status).toBe(400);

      const bogus = await socialStart(startRequest('/oauth/social/start?provider=google&req=smg_rq.bogus'));
      expect(bogus.status).toBe(400);
      expect(await bogus.text()).toContain('expired');
      expect((await socialStart(startRequest('/oauth/social/start?provider=google'))).status).toBe(400);
      const past = Math.floor(Date.now() / 1000) - 5;
      const expired = seal('req', { cid: 'c', ru: REDIRECT, cc: 'x'.repeat(43), cn: 'X', sc: ['read'], sr: true, iat: past - 600, exp: past });
      expect((await socialStart(startRequest(`/oauth/social/start?provider=google&req=${encodeURIComponent(expired)}`))).status).toBe(400);

      // A link from another site, a typed/mailed URL, or a client that sends no Sec-Fetch-Site: all refused (the consent card was never shown).
      for (const site of ['cross-site', 'none', 'same-site']) {
        const res = await socialStart(startRequest(`/oauth/social/start?provider=google&req=${encodeURIComponent(req)}`, { 'sec-fetch-site': site }));
        expect(res.status).toBe(403);
        expect(await res.text()).toContain('only be started from the Splitt sign-in page');
        expect(res.headers.get('set-cookie')).toBeNull();
      }
      const noHeader = await socialStart(new Request(`${BASE}/oauth/social/start?provider=google&req=${encodeURIComponent(req)}`));
      expect(noHeader.status).toBe(403);
    });

    it('refuses to start when return_to would exceed what the backend stores (a very long redirect URI plus maximal state)', async () => {
      // The sealed request carries the client id (which embeds the redirect URIs), the redirect URI again and the state.
      const longRedirect = `https://client.example/${'p'.repeat(700)}`;
      const reg = await register(new Request(`${BASE}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Long', redirect_uris: [longRedirect] }) }));
      expect(reg.status).toBe(201);
      const clientId = (await reg.json()).client_id;
      mockBackendRequest.mockImplementation(async (method: string, path: string) => {
        if (method === 'GET' && path === '/auth/providers') return { google: true, apple: true };
        throw new Error(`unexpected ${method} ${path}`);
      });
      const u = new URL(`${BASE}/oauth/authorize`);
      for (const [k, v] of Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: longRedirect, state: 's'.repeat(512), code_challenge: pkce().challenge, code_challenge_method: 'S256' })) u.searchParams.set(k, v);
      const page = await authorizeGet(new Request(u.toString()));
      expect(page.status).toBe(200); // password sign-in still works for such a client
      const req = hidden(await page.text(), 'req');
      mockBackendRequest.mockClear();

      const res = await socialStart(startRequest(`/oauth/social/start?provider=google&req=${encodeURIComponent(req)}`));
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain('Sign-in request too large');
      expect(html).toContain('email and password');
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(mockBackendRequest).not.toHaveBeenCalled();
    });

    it('fails closed when OAuth is not configured', async () => {
      const { req } = await signInPage();
      delete process.env.MCP_OAUTH_SIGNING_KEY;
      expect((await socialStart(startRequest(`/oauth/social/start?provider=google&req=${encodeURIComponent(req)}`))).status).toBe(404);
      expect((await socialCallback(new Request(`${BASE}/oauth/social/callback?req=x&code=y`))).status).toBe(404);
    });
  });

  describe('callback leg', () => {
    it('swaps the exchange code for a session and issues the authorization code exactly like a password sign-in', async () => {
      const { req, clientId, verifier } = await signInPage('read bookings');
      const { returnTo, cookie } = await start(req);

      exchangeMock((opts) => {
        expect(opts.body).toEqual({ code: EXCHANGE_CODE });
        expect(opts.token).toBeUndefined();
        expect(opts.headers['x-smg-relay-key']).toBe('relay-secret');
        expect(opts.headers['x-smg-client-ip']).toBe(IP);
        expect(opts.headers['User-Agent']).toBe('TestBrowser/1 (via splitt-mcp)');
        return SESSION;
      });
      const res = await socialCallback(callbackRequest(returnTo, { code: EXCHANGE_CODE }, cookie));
      expect(res.status).toBe(302);
      expect(mockBackendRequest).toHaveBeenCalledTimes(1);
      const location = new URL(res.headers.get('location')!);
      expect(location.origin + location.pathname).toBe(REDIRECT);
      expect(location.searchParams.get('state')).toBe('st-1');
      const code = location.searchParams.get('code')!;
      expect(code.startsWith('smg_ac.')).toBe(true);
      // The single-use cookie is dropped on the way out.
      expect(res.headers.get('set-cookie')).toMatch(/^__Host-smg_social=;.*Max-Age=0/);

      // The code is bound to the client, the PKCE challenge and the scopes the page was rendered for.
      const tokenRes = await tokenPost(form({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: clientId }, `${BASE}/oauth/token`));
      expect(tokenRes.status).toBe(200);
      const tokens = await tokenRes.json();
      expect(tokens.scope).toBe('read bookings');
      expect(tokens.access_token.startsWith('smg_at.')).toBe(true);
    });

    it('re-renders the sign-in page with a friendly message for each backend error code', async () => {
      const { req } = await signInPage();
      const { returnTo, cookie } = await start(req);
      const cases: Array<[string, number, string]> = [
        ['user_cancelled', 200, 'You cancelled the sign-in'],
        ['google_auth_failed', 400, 'Google sign-in did not complete'],
        ['apple_auth_failed', 400, 'Apple sign-in did not complete'],
        ['invalid_state', 400, 'expired or was already used'],
        ['email_not_verified', 400, 'not verified with the provider'],
        ['google_not_configured', 503, 'Sign-in with Google is not available'],
        ['apple_not_configured', 503, 'Sign-in with Apple is not available'],
        ['something_else', 400, 'Social sign-in did not complete'],
        ['constructor', 400, 'Social sign-in did not complete'], // prototype members are not error codes
        ['', 400, 'Social sign-in did not complete'],
      ];
      for (const [error, status, message] of cases) {
        const res = await socialCallback(callbackRequest(returnTo, { error }, cookie));
        expect([error, res.status]).toEqual([error, status]);
        const html = await res.text();
        expect(html).toContain(message);
        expect(html).toContain('Test Client'); // the consent card is back, for the same request
        expect(html).toContain('name="req" value="smg_rq.'); // ...and the password form works again
        expect(html).toContain('/oauth/social/start?provider=google'); // ...as do the social buttons
        expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/);
      }
      // Neither code nor error: treated as a failed round-trip, never as a success.
      expect((await socialCallback(callbackRequest(returnTo, {}, cookie))).status).toBe(400);
      expect(mockBackendRequest).not.toHaveBeenCalled();
    });

    it('requires the browser that started the sign-in: no cookie, a foreign cookie or an unbound request are refused before any backend call', async () => {
      const { req } = await signInPage();
      const { returnTo, cookie } = await start(req);
      mockBackendRequest.mockReset();

      const noCookie = await socialCallback(callbackRequest(returnTo, { code: EXCHANGE_CODE }));
      expect(noCookie.status).toBe(400);
      expect(await noCookie.text()).toContain('did not start from the Splitt sign-in page');
      const wrongCookie = await socialCallback(callbackRequest(returnTo, { code: EXCHANGE_CODE }, 'A'.repeat(cookie.length)));
      expect(wrongCookie.status).toBe(400);
      const truncated = await socialCallback(callbackRequest(returnTo, { code: EXCHANGE_CODE }, cookie.slice(1)));
      expect(truncated.status).toBe(400);
      // A deep link straight to the backend would carry the page's own request (no nonce inside): refused even with a cookie.
      const unbound = await socialCallback(callbackRequest(`${BASE}/oauth/social/callback?req=${encodeURIComponent(req)}`, { code: EXCHANGE_CODE }, cookie));
      expect(unbound.status).toBe(400);
      // Errors need the binding too.
      expect((await socialCallback(callbackRequest(returnTo, { error: 'user_cancelled' }))).status).toBe(400);
      expect(mockBackendRequest).not.toHaveBeenCalled();

      // The nonce from one start does not unlock another start's request.
      const second = await start(req);
      expect((await socialCallback(callbackRequest(second.returnTo, { code: EXCHANGE_CODE }, cookie))).status).toBe(400);
      expect(mockBackendRequest).not.toHaveBeenCalled();
    });

    it('refuses a bogus or expired request with the error page', async () => {
      const bogus = await socialCallback(callbackRequest(`${BASE}/oauth/social/callback?req=smg_rq.bogus`, { code: EXCHANGE_CODE }, 'n'));
      expect(bogus.status).toBe(400);
      expect(await bogus.text()).toContain('expired');
      const past = Math.floor(Date.now() / 1000) - 5;
      const expired = seal('req', { cid: 'c', ru: REDIRECT, cc: 'x'.repeat(43), cn: 'X', sc: ['read'], sr: true, sn: 'nonce', iat: past - 600, exp: past });
      expect((await socialCallback(callbackRequest(`${BASE}/oauth/social/callback?req=${encodeURIComponent(expired)}`, { code: EXCHANGE_CODE }, 'nonce'))).status).toBe(400);
      expect((await socialCallback(callbackRequest(`${BASE}/oauth/social/callback`, { code: EXCHANGE_CODE }, 'nonce'))).status).toBe(400);
    });

    it('maps exchange failures: used/expired code 401, suspended account keeps its message, bad request 400, outage 503', async () => {
      const { req } = await signInPage();
      const { returnTo, cookie } = await start(req);

      exchangeMock(() => { throw new BackendApiError(401, 'Invalid or expired sign-in code'); });
      const used = await socialCallback(callbackRequest(returnTo, { code: EXCHANGE_CODE }, cookie));
      expect(used.status).toBe(401);
      expect(await used.text()).toContain('expired or was already used');

      exchangeMock(() => { throw new BackendApiError(401, 'Your account has been suspended. Please contact support.'); });
      const suspended = await socialCallback(callbackRequest(returnTo, { code: EXCHANGE_CODE }, cookie));
      expect(suspended.status).toBe(401);
      expect(await suspended.text()).toContain('Your account has been suspended');

      exchangeMock(() => { throw new BackendApiError(400, 'code must be longer than or equal to 32 characters'); });
      const bad = await socialCallback(callbackRequest(returnTo, { code: EXCHANGE_CODE }, cookie));
      expect(bad.status).toBe(400);
      expect(await bad.text()).toContain('not valid');

      exchangeMock(() => { throw new BackendApiError(502, 'Backend request failed (network error)'); });
      const outage = await socialCallback(callbackRequest(returnTo, { code: EXCHANGE_CODE }, cookie));
      expect(outage.status).toBe(503);
      expect(await outage.text()).toContain('temporarily unavailable');

      exchangeMock(() => ({ unexpected: true }));
      expect((await socialCallback(callbackRequest(returnTo, { code: EXCHANGE_CODE }, cookie))).status).toBe(503);

      // A code that cannot be a backend exchange code never reaches the backend.
      mockBackendRequest.mockClear();
      const short = await socialCallback(callbackRequest(returnTo, { code: 'short' }, cookie));
      expect(short.status).toBe(400);
      expect(await short.text()).toContain('not valid');
      expect(mockBackendRequest).not.toHaveBeenCalled();
    });

    it('continues into the 2FA email-code step when the account has two-step verification on', async () => {
      const { req, clientId, verifier } = await signInPage();
      const { returnTo, cookie } = await start(req);
      const sent: string[] = [];
      mockBackendRequest.mockImplementation(async (method: string, path: string, opts: any) => {
        sent.push(path);
        if (path === '/auth/oauth/exchange') return { twoFactorRequired: true, challengeToken: 'c'.repeat(64), methods: ['email_otp'], defaultMethod: 'email_otp', maskedEmail: 'r***@x.test', expiresAt: new Date(Date.now() + 600_000).toISOString() };
        if (path === '/auth/2fa/otp/send') return { success: true, maskedEmail: 'r***@x.test' };
        if (path === '/auth/2fa/otp/verify') {
          expect(opts.body).toEqual({ challengeToken: 'c'.repeat(64), code: '123456' });
          return { success: true, ...SESSION };
        }
        throw new Error(`unexpected ${method} ${path}`);
      });
      const otp = await socialCallback(callbackRequest(returnTo, { code: EXCHANGE_CODE }, cookie));
      expect(otp.status).toBe(200);
      const otpHtml = await otp.text();
      expect(otpHtml).toContain('r***@x.test');
      expect(sent).toEqual(['/auth/oauth/exchange', '/auth/2fa/otp/send']);
      const chal = hidden(otpHtml, 'chal');

      const redirect = await authorizePost(form({ step: 'otp', chal, code: '123456' }, `${BASE}/oauth/authorize`));
      expect(redirect.status).toBe(302);
      const location = new URL(redirect.headers.get('location')!);
      expect(location.origin + location.pathname).toBe(REDIRECT);
      expect(location.searchParams.get('state')).toBe('st-1');
      const tokenRes = await tokenPost(form({ grant_type: 'authorization_code', code: location.searchParams.get('code')!, code_verifier: verifier, redirect_uri: REDIRECT, client_id: clientId }, `${BASE}/oauth/token`));
      expect(tokenRes.status).toBe(200);
    });

    it('throttles repeated failures per IP and per started sign-in, like the password path', async () => {
      const { req } = await signInPage();
      const { returnTo, cookie } = await start(req);
      exchangeMock(() => { throw new BackendApiError(401, 'Invalid or expired sign-in code'); });
      for (let i = 0; i < 10; i++) expect((await socialCallback(callbackRequest(returnTo, { code: EXCHANGE_CODE }, cookie))).status).toBe(401);
      const throttled = await socialCallback(callbackRequest(returnTo, { code: EXCHANGE_CODE }, cookie));
      expect(throttled.status).toBe(429);
      expect(await throttled.text()).toContain('Too many sign-in attempts');
      expect(mockBackendRequest).toHaveBeenCalledTimes(10);

      // Same started sign-in from another IP: still throttled (per-nonce key).
      const otherIp = await socialCallback(callbackRequest(returnTo, { code: EXCHANGE_CODE }, cookie, { 'x-real-ip': '198.51.100.7' }));
      expect(otherIp.status).toBe(429);
      // A fresh start from that other IP is unaffected.
      const fresh = await start(req);
      exchangeMock(() => SESSION);
      expect((await socialCallback(callbackRequest(fresh.returnTo, { code: EXCHANGE_CODE }, fresh.cookie, { 'x-real-ip': '198.51.100.7' }))).status).toBe(302);
    });
  });
});
