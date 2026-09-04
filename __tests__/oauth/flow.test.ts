/**
 * End-to-end OAuth 2.1 flow against a mocked backend: register → authorize
 * (hosted login, incl. the 2FA OTP step) → code → token → use at /api/mcp →
 * refresh → revoke. Exercises the real route handlers.
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
jest.mock('@/middleware/rate-limit', () => ({ rateLimiter: jest.fn().mockResolvedValue({ success: true, remaining: 5 }) }));

import { POST as register } from '../../src/app/oauth/register/route';
import { GET as authorizeGet, POST as authorizePost } from '../../src/app/oauth/authorize/route';
import { POST as tokenPost } from '../../src/app/oauth/token/route';
import { POST as revokePost } from '../../src/app/oauth/revoke/route';
import { GET as prmGet } from '../../src/app/.well-known/oauth-protected-resource/[[...path]]/route';
import { GET as asGet } from '../../src/app/.well-known/oauth-authorization-server/[[...path]]/route';
import { POST as mcpPost } from '../../src/app/api/mcp/route';
import { _resetThrottle } from '../../src/lib/oauth/throttle';

const KEY = 'unit-test-signing-key-with-at-least-32-bytes!!';
const BASE = 'https://mcp.test';
const REDIRECT = 'https://client.example/callback';

function backendJwt(payload: Record<string, unknown>): string {
  const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg(payload)}.sig`;
}
const FUTURE = Math.floor(Date.now() / 1000) + 900;
let backendAccess = backendJwt({ sub: 'user-1', email: 'r@x.test', role: 'renter', exp: FUTURE });

function form(body: Record<string, string>, url = `${BASE}/oauth/token`, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'POST',
    // Browsers send Origin + Sec-Fetch-Site on form posts; the sign-in form requires same-origin.
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE, 'sec-fetch-site': 'same-origin', 'x-real-ip': '203.0.113.9', 'user-agent': 'TestClient/1', ...headers },
    body: new URLSearchParams(body).toString(),
  });
}
const NO_PARAMS = { params: Promise.resolve({ path: [] as string[] }) };
const MCP_PARAMS = { params: Promise.resolve({ path: ['api', 'mcp'] }) };
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
function authorizeUrl(params: Record<string, string>): string {
  const u = new URL(`${BASE}/oauth/authorize`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}
function hidden(html: string, name: string): string {
  const m = html.match(new RegExp(`name="${name}" value="([^"]+)"`));
  if (!m) throw new Error(`hidden field ${name} not found`);
  return m[1].replace(/&amp;/g, '&');
}
function mcp(headers: Record<string, string>, body: unknown): Promise<Response> {
  const req: any = new Request(`${BASE}/api/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });
  req.nextUrl = { pathname: '/api/mcp' };
  return mcpPost(req);
}

describe('OAuth 2.1 flow', () => {
  beforeEach(() => {
    process.env.MCP_OAUTH_SIGNING_KEY = KEY;
    process.env.MCP_PUBLIC_URL = BASE;
    process.env.MCP_API_KEY = 'operator';
    process.env.MCP_BFF_RELAY_KEY = 'relay-secret';
    process.env.MCP_TRUST_PROXY_HEADERS = '1';
    _resetThrottle();
    mockBackendRequest.mockReset();
  });
  afterEach(() => {
    delete process.env.MCP_OAUTH_SIGNING_KEY;
    delete process.env.MCP_PUBLIC_URL;
    delete process.env.MCP_API_KEY;
    delete process.env.MCP_BFF_RELAY_KEY;
    delete process.env.MCP_TRUST_PROXY_HEADERS;
  });

  it('serves discovery metadata (root and path-aware) and advertises it on 401', async () => {
    const prm = await (await prmGet(new Request(`${BASE}/.well-known/oauth-protected-resource/api/mcp`), MCP_PARAMS)).json();
    expect(prm.resource).toBe(`${BASE}/api/mcp`);
    expect(prm.authorization_servers).toEqual([BASE]);
    const as = await (await asGet(new Request(`${BASE}/.well-known/oauth-authorization-server`), NO_PARAMS)).json();
    // Only the root and our resource path are answered (RFC 8414 path-aware discovery).
    expect((await asGet(new Request(`${BASE}/.well-known/oauth-authorization-server/other`), { params: Promise.resolve({ path: ['other'] }) })).status).toBe(404);
    expect(as).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/oauth/token`,
      registration_endpoint: `${BASE}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
    const unauth = await mcp({}, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/api/mcp"`);
    const bad = await mcp({ authorization: 'Bearer smg_at.garbage' }, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('completes register → login → code → token → tools/list → refresh → revoke', async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();

    // GET authorize renders the hosted login with the request sealed in a hidden field.
    const page = await authorizeGet(new Request(authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 'xyz', code_challenge: challenge, code_challenge_method: 'S256', resource: `${BASE}/api/mcp` })));
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).toContain('Test Client');
    expect(html).toContain('https://client.example/callback');
    expect(html).toContain('unverified app'); // no allow-list configured in this test
    const req = hidden(html, 'req');

    // POST login → backend login → code redirect.
    mockBackendRequest.mockImplementation(async (method: string, path: string, opts: any) => {
      if (method === 'POST' && path === '/users/login') {
        expect(opts.body).toEqual({ email: 'r@x.test', password: 'pw' });
        expect(opts.headers['x-smg-relay-key']).toBe('relay-secret');
        expect(opts.headers['x-smg-client-ip']).toBe('203.0.113.9');
        return { accessToken: backendAccess, refreshToken: 'brt-1', user: { id: 'user-1', email: 'r@x.test', role: 'renter' } };
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    const redirect = await authorizePost(form({ step: 'login', req, email: 'r@x.test', password: 'pw' }, `${BASE}/oauth/authorize`));
    expect(redirect.status).toBe(302);
    const location = new URL(redirect.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get('state')).toBe('xyz');
    const code = location.searchParams.get('code')!;
    expect(code.startsWith('smg_ac.')).toBe(true);

    // Wrong verifier / wrong redirect / wrong client are rejected.
    const badVerifier = await tokenPost(form({ grant_type: 'authorization_code', code, code_verifier: crypto.randomBytes(32).toString('base64url'), redirect_uri: REDIRECT, client_id: clientId }));
    expect(badVerifier.status).toBe(400);
    expect((await badVerifier.json()).error).toBe('invalid_grant');
    const badRedirect = await tokenPost(form({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: 'https://client.example/other', client_id: clientId }));
    expect((await badRedirect.json()).error).toBe('invalid_grant');

    // Exchange.
    const tokenRes = await tokenPost(form({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: clientId, resource: `${BASE}/api/mcp` }));
    expect(tokenRes.status).toBe(200);
    const tokens = await tokenRes.json();
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.access_token.startsWith('smg_at.')).toBe(true);
    expect(tokens.refresh_token.startsWith('smg_rt.')).toBe(true);
    expect(tokens.expires_in).toBeGreaterThan(0);
    expect(tokens.expires_in).toBeLessThanOrEqual(900);

    // Replay of the same code is refused.
    const replay = await tokenPost(form({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: clientId }));
    expect((await replay.json()).error).toBe('invalid_grant');

    // The access token authenticates at /api/mcp as the renter (role-aware tool list).
    const listRes = await mcp({ authorization: `Bearer ${tokens.access_token}` }, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(listRes.status).toBe(200);
    const names = (await listRes.json()).result.tools.map((t: any) => t.name);
    expect(names).toContain('create_booking');
    expect(names).toContain('get_my_profile');
    expect(names).not.toContain('list_my_listings');

    // A user tool forwards the INNER backend JWT, never the envelope.
    mockBackendRequest.mockImplementation(async (method: string, path: string, opts: any) => {
      if (method === 'GET' && path === '/users/me') {
        expect(opts.token).toBe(backendAccess);
        return { id: 'user-1', email: 'r@x.test', role: 'renter' };
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    const callRes = await mcp({ authorization: `Bearer ${tokens.access_token}` }, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_my_profile', arguments: {} } });
    const callBody = await callRes.json();
    expect(callBody.result.isError).toBeFalsy();
    expect(callBody.result.content[0].text).toContain('"authenticatedVia": "oauth"');

    // Refresh rotates via the backend and re-wraps.
    const rotatedAccess = backendJwt({ sub: 'user-1', email: 'r@x.test', role: 'renter', exp: FUTURE + 60 });
    mockBackendRequest.mockImplementation(async (method: string, path: string, opts: any) => {
      if (method === 'POST' && path === '/auth/refresh') {
        expect(opts.body).toEqual({ refreshToken: 'brt-1' });
        return { accessToken: rotatedAccess, refreshToken: 'brt-2', expiresIn: 900 };
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    const refreshRes = await tokenPost(form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }));
    expect(refreshRes.status).toBe(200);
    const refreshed = await refreshRes.json();
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);

    // A refresh token presented by a different client is refused.
    const otherClient = await registerClient();
    const wrongClient = await tokenPost(form({ grant_type: 'refresh_token', refresh_token: refreshed.refresh_token, client_id: otherClient }));
    expect((await wrongClient.json()).error).toBe('invalid_grant');

    // Revoke: rotate then log out at the backend; always 200.
    const calls: string[] = [];
    mockBackendRequest.mockImplementation(async (method: string, path: string, opts: any) => {
      calls.push(`${method} ${path}`);
      if (path === '/auth/refresh') return { accessToken: rotatedAccess, refreshToken: 'brt-3' };
      if (path === '/auth/logout') { expect(opts.token).toBe(rotatedAccess); expect(opts.body).toEqual({ refreshToken: 'brt-3' }); return { message: 'ok' }; }
      throw new Error(`unexpected ${method} ${path}`);
    });
    const revokeRes = await revokePost(form({ token: refreshed.refresh_token, client_id: clientId }, `${BASE}/oauth/revoke`));
    expect(revokeRes.status).toBe(200);
    expect(calls).toEqual(['POST /auth/refresh', 'POST /auth/logout']);
  });

  it('handles the 2FA email-OTP step', async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const html = await (await authorizeGet(new Request(authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' })))).text();
    const req = hidden(html, 'req');

    const sent: string[] = [];
    mockBackendRequest.mockImplementation(async (method: string, path: string, opts: any) => {
      sent.push(path);
      if (path === '/users/login') return { twoFactorRequired: true, challengeToken: 'c'.repeat(64), methods: ['email_otp'], defaultMethod: 'email_otp', maskedEmail: 'r***@x.test', expiresAt: new Date(Date.now() + 600_000).toISOString() };
      if (path === '/auth/2fa/otp/send') return { success: true, maskedEmail: 'r***@x.test', resendAvailableAt: new Date().toISOString() };
      if (path === '/auth/2fa/otp/verify') {
        expect(opts.body).toEqual({ challengeToken: 'c'.repeat(64), code: '123456' });
        return { success: true, accessToken: backendAccess, refreshToken: 'brt-9', user: { id: 'user-1', email: 'r@x.test', role: 'renter' } };
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    const otpPage = await authorizePost(form({ step: 'login', req, email: 'r@x.test', password: 'pw' }, `${BASE}/oauth/authorize`));
    expect(otpPage.status).toBe(200);
    const otpHtml = await otpPage.text();
    expect(otpHtml).toContain('r***@x.test');
    expect(sent).toEqual(['/users/login', '/auth/2fa/otp/send']);
    const chal = hidden(otpHtml, 'chal');

    const redirect = await authorizePost(form({ step: 'otp', chal, code: '123456' }, `${BASE}/oauth/authorize`));
    expect(redirect.status).toBe(302);
    const code = new URL(redirect.headers.get('location')!).searchParams.get('code')!;
    const tokenRes = await tokenPost(form({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: clientId }));
    expect(tokenRes.status).toBe(200);
  });

  it('never redirects on an unknown client or unregistered redirect_uri, and redirects other errors', async () => {
    const clientId = await registerClient();
    const unknown = await authorizeGet(new Request(authorizeUrl({ response_type: 'code', client_id: 'smg_c.forged.sig', redirect_uri: REDIRECT, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' })));
    expect(unknown.status).toBe(400);
    const badRedirect = await authorizeGet(new Request(authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: 'https://attacker.example/cb', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' })));
    expect(badRedirect.status).toBe(400);
    const noPkce = await authorizeGet(new Request(authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 's1' })));
    expect(noPkce.status).toBe(302);
    const loc = new URL(noPkce.headers.get('location')!);
    expect(loc.searchParams.get('error')).toBe('invalid_request');
    expect(loc.searchParams.get('state')).toBe('s1');
    const plain = await authorizeGet(new Request(authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: 'x'.repeat(43), code_challenge_method: 'plain' })));
    expect(new URL(plain.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');
    const wrongResource = await authorizeGet(new Request(authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', resource: 'https://other.example/api' })));
    expect(new URL(wrongResource.headers.get('location')!).searchParams.get('error')).toBe('invalid_target');
  });

  it('shows bad credentials on the form, honours the cancel button, and throttles repeated failures', async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const html = await (await authorizeGet(new Request(authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 'st', code_challenge: challenge, code_challenge_method: 'S256' })))).text();
    const req = hidden(html, 'req');
    const { BackendApiError } = jest.requireMock('../../src/lib/backend-client');
    mockBackendRequest.mockImplementation(async () => { throw new BackendApiError(401, 'Invalid email or password'); });

    const bad = await authorizePost(form({ step: 'login', req, email: 'r@x.test', password: 'nope' }, `${BASE}/oauth/authorize`));
    expect(bad.status).toBe(401);
    expect(await bad.text()).toContain('Invalid email or password');

    for (let i = 0; i < 9; i++) await authorizePost(form({ step: 'login', req, email: 'r@x.test', password: 'nope' }, `${BASE}/oauth/authorize`));
    const throttled = await authorizePost(form({ step: 'login', req, email: 'r@x.test', password: 'nope' }, `${BASE}/oauth/authorize`));
    expect(throttled.status).toBe(429);

    const cancel = await authorizePost(form({ step: 'cancel', req }, `${BASE}/oauth/authorize`));
    expect(cancel.status).toBe(302);
    const loc = new URL(cancel.headers.get('location')!);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('state')).toBe('st');

    const expired = await authorizePost(form({ step: 'login', req: 'smg_rq.bogus', email: 'a@b.c', password: 'x' }, `${BASE}/oauth/authorize`));
    expect(expired.status).toBe(400);

    // A backend outage is a 503 with a friendly message, never a 401 that blames the user.
    _resetThrottle();
    mockBackendRequest.mockImplementation(async () => { throw new BackendApiError(502, 'Backend request failed (network error)'); });
    const outage = await authorizePost(form({ step: 'login', req, email: 'r@x.test', password: 'pw' }, `${BASE}/oauth/authorize`));
    expect(outage.status).toBe(503);
    expect(await outage.text()).toContain('temporarily unavailable');
  });

  it('fails closed when OAuth is not configured', async () => {
    delete process.env.MCP_OAUTH_SIGNING_KEY;
    expect((await prmGet(new Request(`${BASE}/.well-known/oauth-protected-resource`), NO_PARAMS)).status).toBe(404);
    expect((await register(new Request(`${BASE}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))).status).toBe(503);
    expect((await tokenPost(form({ grant_type: 'authorization_code' }))).status).toBe(503);
    expect((await authorizeGet(new Request(authorizeUrl({ client_id: 'x' })))).status).toBe(404);
    const unauth = await mcp({}, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(unauth.headers.get('www-authenticate')).toBe('Bearer');
    const env = await mcp({ authorization: 'Bearer smg_at.anything' }, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(env.status).toBe(401);
  });

  it('rejects malformed token requests with the right OAuth errors', async () => {
    expect((await (await tokenPost(form({}))).json()).error).toBe('invalid_request');
    expect((await (await tokenPost(form({ grant_type: 'password' }))).json()).error).toBe('unsupported_grant_type');
    expect((await (await tokenPost(form({ grant_type: 'authorization_code', code: 'x' }))).json()).error).toBe('invalid_request');
    expect((await (await tokenPost(form({ grant_type: 'refresh_token', refresh_token: 'smg_rt.nope' }))).json()).error).toBe('invalid_request'); // client_id required
    expect((await (await tokenPost(form({ grant_type: 'refresh_token', refresh_token: 'smg_rt.nope', client_id: 'c' }))).json()).error).toBe('invalid_grant');
    expect((await (await revokePost(form({ token: 'smg_rt.nope' }, `${BASE}/oauth/revoke`))).json()).error).toBe('invalid_request');
    expect((await (await tokenPost(form({ grant_type: 'authorization_code', code: 'smg_ac.nope', code_verifier: 'v'.repeat(43), redirect_uri: REDIRECT, client_id: 'c' }))).json()).error).toBe('invalid_grant');
  });

  it('blocks cross-site form submissions and ignores untrusted proxy headers', async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const html = await (await authorizeGet(new Request(authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' })))).text();
    const req = hidden(html, 'req');

    const crossSite = await authorizePost(form({ step: 'login', req, email: 'r@x.test', password: 'pw' }, `${BASE}/oauth/authorize`, { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' }));
    expect(crossSite.status).toBe(403);
    const wrongOriginOnly = await authorizePost(form({ step: 'login', req, email: 'r@x.test', password: 'pw' }, `${BASE}/oauth/authorize`, { origin: 'https://attacker.example', 'sec-fetch-site': 'same-origin' }));
    expect(wrongOriginOnly.status).toBe(403);
    expect(mockBackendRequest).not.toHaveBeenCalled();

    // Off-Vercel without MCP_TRUST_PROXY_HEADERS: x-real-ip is attacker-controlled → not relayed.
    delete process.env.MCP_TRUST_PROXY_HEADERS;
    mockBackendRequest.mockImplementation(async (_m: string, path: string, opts: any) => {
      if (path === '/users/login') {
        expect(opts.headers['x-smg-client-ip']).toBeUndefined();
        expect(opts.headers['x-smg-relay-key']).toBeUndefined();
        expect(opts.headers['User-Agent']).toBe('TestClient/1 (via splitt-mcp)');
        return { accessToken: backendAccess, refreshToken: 'brt-1', user: { id: 'user-1', email: 'r@x.test', role: 'renter' } };
      }
      throw new Error(`unexpected ${path}`);
    });
    const ok = await authorizePost(form({ step: 'login', req, email: 'r@x.test', password: 'pw' }, `${BASE}/oauth/authorize`, { 'x-real-ip': '198.51.100.7' }));
    expect(ok.status).toBe(302);
  });

  it('does not reset the failure budget on a successful login (per-IP and per-account keys)', async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const html = await (await authorizeGet(new Request(authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' })))).text();
    const req = hidden(html, 'req');
    const { BackendApiError } = jest.requireMock('../../src/lib/backend-client');
    mockBackendRequest.mockImplementation(async (_m: string, _p: string, opts: any) => {
      if (opts.body.email === 'victim@x.test') throw new BackendApiError(401, 'Invalid email or password');
      return { accessToken: backendAccess, refreshToken: 'brt-1', user: { id: 'user-1', email: 'r@x.test', role: 'renter' } };
    });
    for (let i = 0; i < 9; i++) await authorizePost(form({ step: 'login', req, email: 'victim@x.test', password: 'guess' }, `${BASE}/oauth/authorize`));
    // A successful login for another account from the same IP must not clear the budget.
    expect((await authorizePost(form({ step: 'login', req, email: 'r@x.test', password: 'pw' }, `${BASE}/oauth/authorize`))).status).toBe(302);
    await authorizePost(form({ step: 'login', req, email: 'victim@x.test', password: 'guess' }, `${BASE}/oauth/authorize`));
    expect((await authorizePost(form({ step: 'login', req, email: 'victim@x.test', password: 'guess' }, `${BASE}/oauth/authorize`))).status).toBe(429);
    // The per-account key also trips from a different IP (distributed spray on one account).
    expect((await authorizePost(form({ step: 'login', req, email: 'victim@x.test', password: 'guess' }, `${BASE}/oauth/authorize`, { 'x-real-ip': '198.51.100.99' }))).status).toBe(429);
    // …but a different account from that other IP is unaffected (no lockout of bystanders).
    expect((await authorizePost(form({ step: 'login', req, email: 'other@x.test', password: 'pw' }, `${BASE}/oauth/authorize`, { 'x-real-ip': '198.51.100.99' }))).status).toBe(302);
  });

  it('maps a rejected refresh (400/401) to invalid_grant and answers 405 on GET/DELETE of /api/mcp', async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const html = await (await authorizeGet(new Request(authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' })))).text();
    const req = hidden(html, 'req');
    mockBackendRequest.mockImplementation(async () => ({ accessToken: backendAccess, refreshToken: 'brt-1', user: { id: 'user-1', email: 'r@x.test', role: 'renter' } }));
    const code = new URL((await authorizePost(form({ step: 'login', req, email: 'r@x.test', password: 'pw' }, `${BASE}/oauth/authorize`))).headers.get('location')!).searchParams.get('code')!;
    const tokens = await (await tokenPost(form({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: clientId }))).json();

    const { BackendApiError } = jest.requireMock('../../src/lib/backend-client');
    mockBackendRequest.mockImplementation(async () => { throw new BackendApiError(400, 'refreshToken must be a string'); });
    const res = await tokenPost(form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');

    const { GET: mcpGet, DELETE: mcpDelete } = await import('../../src/app/api/mcp/route');
    expect((await mcpGet()).status).toBe(405);
    expect((await mcpDelete()).status).toBe(405);
  });
});
