/**
 * Client compatibility of the authorization server with the MCP clients that
 * connect to it in practice (Claude, Claude Code, ChatGPT), per their own
 * documentation:
 *  - RFC 9207 `iss` on every authorization response (ChatGPT uses its stable
 *    redirect URI only for servers that promise it);
 *  - loopback redirects match on any port (RFC 8252 §7.3; Claude Code binds
 *    an ephemeral port per sign-in and declares the portless form);
 *  - `resource` accepted as the MCP endpoint or the bare origin, with or
 *    without a trailing slash (ChatGPT documents sending the origin);
 *  - a refresh repeated within the rotation grace window gets the same answer
 *    instead of a spurious invalid_grant (see lib/oauth/refresh-grace).
 */
export {};
import crypto from 'crypto';
import { NextRequest } from 'next/server';

const mockBackendRequest = jest.fn();
jest.mock('../../src/lib/backend-client', () => {
  class BackendApiError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.name = 'BackendApiError'; this.status = status; }
  }
  return { BackendApiError, backendRequest: (...args: unknown[]) => mockBackendRequest(...args), backendBaseUrl: () => 'http://backend.test/api/v1' };
});
jest.mock('@/middleware/rate-limit', () => ({
  rateLimiter: jest.fn().mockResolvedValue({ success: true, remaining: 5 }),
  toolCallRateLimiter: jest.fn().mockResolvedValue({ success: true }),
  countToolCalls: jest.fn().mockReturnValue(0),
}));

import { POST as register } from '../../src/app/oauth/register/route';
import { GET as authorizeGet, POST as authorizePost } from '../../src/app/oauth/authorize/route';
import { POST as tokenPost } from '../../src/app/oauth/token/route';
import { GET as asGet } from '../../src/app/.well-known/oauth-authorization-server/[[...path]]/route';
import { _resetThrottle } from '../../src/lib/oauth/throttle';
import { _resetRefreshGraceForTests, REFRESH_GRACE_S } from '../../src/lib/oauth/refresh-grace';
import { _resetSharedStoreForTests } from '../../src/lib/shared-store';

const KEY = 'unit-test-signing-key-with-at-least-32-bytes!!';
const BASE = 'https://mcp.test';
const HTTPS_REDIRECT = 'https://client.example/callback';

function backendJwt(payload: Record<string, unknown>): string {
  const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg(payload)}.sig`;
}
const FUTURE = Math.floor(Date.now() / 1000) + 900;
const backendAccess = backendJwt({ sub: 'user-1', email: 'v@x.test', role: 'vendor_owner', exp: FUTURE });

function form(body: Record<string, string>, url = `${BASE}/oauth/token`): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE, 'sec-fetch-site': 'same-origin', 'user-agent': 'TestClient/1' },
    body: new URLSearchParams(body).toString(),
  });
}
async function registerClient(redirectUris: string[], name = 'Test Client'): Promise<string> {
  const res = await register(new Request(`${BASE}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: name, redirect_uris: redirectUris }) }));
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
function loginSucceeds(): void {
  mockBackendRequest.mockImplementation(async (method: string, path: string) => {
    if (method === 'POST' && path === '/users/login') {
      return { accessToken: backendAccess, refreshToken: 'brt-1', user: { id: 'user-1', email: 'v@x.test', role: 'vendor_owner' } };
    }
    if (method === 'GET' && path === '/auth/providers') return { google: false, apple: false };
    throw new Error(`unexpected ${method} ${path}`);
  });
}
/** Drive authorize (GET + password POST) and return the redirect Location. */
async function signIn(
  clientId: string,
  redirectUri: string,
  extra: Record<string, string> = {},
  makeRequest: (url: string) => Request = (url) => new Request(url),
): Promise<{ location: URL; verifier: string }> {
  const { verifier, challenge } = pkce();
  loginSucceeds();
  const page = await authorizeGet(makeRequest(authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state: 's1', code_challenge: challenge, code_challenge_method: 'S256', ...extra })));
  expect(page.status).toBe(200);
  const res = await authorizePost(form({ step: 'login', req: hidden(await page.text(), 'req'), email: 'v@x.test', password: 'pw' }, `${BASE}/oauth/authorize`));
  expect(res.status).toBe(302);
  return { location: new URL(res.headers.get('location')!), verifier };
}

describe('OAuth client compatibility', () => {
  beforeEach(() => {
    process.env.MCP_OAUTH_SIGNING_KEY = KEY;
    process.env.MCP_PUBLIC_URL = BASE;
    process.env.MCP_OAUTH_ALLOWED_REDIRECT_HOSTS = 'client.example';
    _resetThrottle();
    _resetRefreshGraceForTests();
    _resetSharedStoreForTests();
    mockBackendRequest.mockReset();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const name of ['MCP_OAUTH_SIGNING_KEY', 'MCP_PUBLIC_URL', 'MCP_OAUTH_ALLOWED_REDIRECT_HOSTS', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[name];
    jest.restoreAllMocks();
  });

  describe('RFC 9207 issuer identification', () => {
    it('is advertised in the authorization server metadata', async () => {
      const as = await (await asGet(new Request(`${BASE}/.well-known/oauth-authorization-server`), { params: Promise.resolve({ path: [] as string[] }) })).json();
      expect(as.authorization_response_iss_parameter_supported).toBe(true);
      expect(as.token_endpoint_auth_methods_supported).toEqual(['none']);
      expect(as.code_challenge_methods_supported).toEqual(['S256']);
    });

    it('rides on the code redirect, equal to the metadata issuer', async () => {
      const clientId = await registerClient([HTTPS_REDIRECT]);
      const { location } = await signIn(clientId, HTTPS_REDIRECT);
      expect(location.searchParams.get('code')).toMatch(/^smg_ac\./);
      expect(location.searchParams.get('iss')).toBe(BASE);
      expect(location.searchParams.get('state')).toBe('s1');
    });

    it('rides on every error redirect too (bad request and user cancel)', async () => {
      const clientId = await registerClient([HTTPS_REDIRECT]);
      const { challenge } = pkce();
      const bad = await authorizeGet(new Request(authorizeUrl({ response_type: 'token', client_id: clientId, redirect_uri: HTTPS_REDIRECT, state: 's2', code_challenge: challenge, code_challenge_method: 'S256' })));
      const badLocation = new URL(bad.headers.get('location')!);
      expect(badLocation.searchParams.get('error')).toBe('unsupported_response_type');
      expect(badLocation.searchParams.get('iss')).toBe(BASE);

      loginSucceeds();
      const page = await authorizeGet(new Request(authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: HTTPS_REDIRECT, state: 's3', code_challenge: challenge, code_challenge_method: 'S256' })));
      const cancel = await authorizePost(form({ step: 'cancel', req: hidden(await page.text(), 'req') }, `${BASE}/oauth/authorize`));
      const cancelLocation = new URL(cancel.headers.get('location')!);
      expect(cancelLocation.searchParams.get('error')).toBe('access_denied');
      expect(cancelLocation.searchParams.get('iss')).toBe(BASE);
    });
  });

  describe('loopback redirects (Claude Code) match on any port', () => {
    it('accepts the portless registration Claude Code declares, on any port, for localhost and 127.0.0.1', async () => {
      const clientId = await registerClient(['http://localhost/callback', 'http://127.0.0.1/callback'], 'Claude Code');
      for (const redirect of ['http://localhost:3118/callback', 'http://127.0.0.1:51234/callback', 'http://localhost/callback']) {
        const { location, verifier } = await signIn(clientId, redirect);
        expect(`${location.origin}${location.pathname}`).toBe(redirect);
        // The token request must name the exact redirect the authorize request used.
        const code = location.searchParams.get('code')!;
        const token = await tokenPost(form({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect, client_id: clientId }));
        expect(token.status).toBe(200);
      }
    });

    it('still requires the same host, path and query; only the port is free', async () => {
      const clientId = await registerClient(['http://localhost/callback']);
      const { challenge } = pkce();
      for (const redirect of ['http://127.0.0.1:3118/callback', 'http://localhost:3118/other', 'http://localhost:3118/callback?x=1', 'http://localhost:3118/callback/']) {
        const res = await authorizeGet(new Request(authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256' })));
        expect(res.status).toBe(400);
        expect(res.headers.get('location')).toBeNull();
      }
    });

    it('does not relax the port for https redirects', async () => {
      const clientId = await registerClient([HTTPS_REDIRECT]);
      const { challenge } = pkce();
      const res = await authorizeGet(new Request(authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: 'https://client.example:8443/callback', code_challenge: challenge, code_challenge_method: 'S256' })));
      expect(res.status).toBe(400);
    });

    it('refuses a token request whose loopback port differs from the authorize request', async () => {
      const clientId = await registerClient(['http://localhost/callback']);
      const { location, verifier } = await signIn(clientId, 'http://localhost:3118/callback');
      const token = await tokenPost(form({ grant_type: 'authorization_code', code: location.searchParams.get('code')!, code_verifier: verifier, redirect_uri: 'http://localhost:4000/callback', client_id: clientId }));
      expect((await token.json()).error).toBe('invalid_grant');
    });

    it('warns on the consent page that the app runs on this computer, and names where the browser returns', async () => {
      const clientId = await registerClient(['http://localhost/callback'], 'Claude Code');
      const { challenge } = pkce();
      loginSucceeds();
      const loopback = await (await authorizeGet(new Request(authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: 'http://localhost:3118/callback', code_challenge: challenge, code_challenge_method: 'S256' })))).text();
      expect(loopback).toContain('This app runs on your own computer');
      expect(loopback).toContain('an app on this computer (<b>localhost:3118</b>)');

      const httpsClient = await registerClient([HTTPS_REDIRECT], 'ChatGPT');
      const hosted = await (await authorizeGet(new Request(authorizeUrl({ response_type: 'code', client_id: httpsClient, redirect_uri: HTTPS_REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' })))).text();
      expect(hosted).not.toContain('This app runs on your own computer');
      expect(hosted).toContain('you go back to <b>client.example</b>');
    });

    describe('through the NextRequest that Next.js hands the route in production', () => {
      // NextRequest rewrites the first loopback address anywhere in its URL,
      // query string included, to "localhost". On a public host that first
      // address is the redirect_uri: on staging a client that registered only
      // 127.0.0.1 was refused, and a localhost-only client was let through on
      // 127.0.0.1. Plain Request objects never showed it.
      const viaNext = (url: string) => new NextRequest(url);

      it('signs in a client that registered only 127.0.0.1 (RFC 8252 §8.3) and returns to exactly that address', async () => {
        const clientId = await registerClient(['http://127.0.0.1/callback'], 'Loopback IP client');
        const redirect = 'http://127.0.0.1:33418/callback';
        const { location, verifier } = await signIn(clientId, redirect, {}, viaNext);
        expect(`${location.origin}${location.pathname}`).toBe(redirect);
        const token = await tokenPost(form({ grant_type: 'authorization_code', code: location.searchParams.get('code')!, code_verifier: verifier, redirect_uri: redirect, client_id: clientId }));
        expect(token.status).toBe(200);
      });

      it('sends a client that registered both forms back to the one it asked for', async () => {
        const clientId = await registerClient(['http://localhost/callback', 'http://127.0.0.1/callback'], 'Claude Code');
        const redirect = 'http://127.0.0.1:51234/callback';
        const { location, verifier } = await signIn(clientId, redirect, {}, viaNext);
        expect(`${location.origin}${location.pathname}`).toBe(redirect);
        const token = await tokenPost(form({ grant_type: 'authorization_code', code: location.searchParams.get('code')!, code_verifier: verifier, redirect_uri: redirect, client_id: clientId }));
        expect(token.status).toBe(200);
      });

      it('still refuses 127.0.0.1 for a client that registered only localhost', async () => {
        const clientId = await registerClient(['http://localhost/callback']);
        const { challenge } = pkce();
        const res = await authorizeGet(viaNext(authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: 'http://127.0.0.1:3118/callback', code_challenge: challenge, code_challenge_method: 'S256' })));
        expect(res.status).toBe(400);
        expect(res.headers.get('location')).toBeNull();
      });

      it('returns a state that contains a loopback address unchanged', async () => {
        const clientId = await registerClient([HTTPS_REDIRECT]);
        const state = 'next=http://127.0.0.1:8080/done';
        const { location } = await signIn(clientId, HTTPS_REDIRECT, { state }, viaNext);
        expect(location.searchParams.get('state')).toBe(state);
      });
    });
  });

  describe('RFC 8707 resource', () => {
    it('accepts the MCP endpoint or the bare origin, with or without a trailing slash, at authorize and token', async () => {
      const clientId = await registerClient([HTTPS_REDIRECT]);
      for (const resource of [`${BASE}/api/mcp`, `${BASE}/api/mcp/`, BASE, `${BASE}/`, 'https://MCP.test/api/mcp']) {
        const { location, verifier } = await signIn(clientId, HTTPS_REDIRECT, { resource });
        const token = await tokenPost(form({ grant_type: 'authorization_code', code: location.searchParams.get('code')!, code_verifier: verifier, redirect_uri: HTTPS_REDIRECT, client_id: clientId, resource }));
        expect(token.status).toBe(200);
      }
    });

    it('refuses a resource that names another server or path, at authorize (redirected, with iss) and at token', async () => {
      const clientId = await registerClient([HTTPS_REDIRECT]);
      const { challenge } = pkce();
      for (const resource of ['https://other.test/api/mcp', `${BASE}/api/other`, `${BASE}/api/mcp#frag`, 'not a url']) {
        const res = await authorizeGet(new Request(authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: HTTPS_REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', resource })));
        const location = new URL(res.headers.get('location')!);
        expect(location.searchParams.get('error')).toBe('invalid_target');
        expect(location.searchParams.get('iss')).toBe(BASE);
      }
      const { location, verifier } = await signIn(clientId, HTTPS_REDIRECT);
      const token = await tokenPost(form({ grant_type: 'authorization_code', code: location.searchParams.get('code')!, code_verifier: verifier, redirect_uri: HTTPS_REDIRECT, client_id: clientId, resource: 'https://other.test/api/mcp' }));
      expect((await token.json()).error).toBe('invalid_target');
    });
  });

  describe('refresh rotation grace', () => {
    async function tokensFor(): Promise<{ clientId: string; refreshToken: string }> {
      const clientId = await registerClient([HTTPS_REDIRECT]);
      const { location, verifier } = await signIn(clientId, HTTPS_REDIRECT);
      const res = await tokenPost(form({ grant_type: 'authorization_code', code: location.searchParams.get('code')!, code_verifier: verifier, redirect_uri: HTTPS_REDIRECT, client_id: clientId }));
      return { clientId, refreshToken: (await res.json()).refresh_token };
    }
    function rotatingBackend(): jest.Mock {
      let n = 1;
      const refreshCalls = jest.fn();
      mockBackendRequest.mockImplementation(async (method: string, path: string, opts: { body?: { refreshToken?: string } }) => {
        if (method === 'POST' && path === '/auth/refresh') {
          refreshCalls(opts.body?.refreshToken);
          n += 1;
          return { accessToken: backendJwt({ sub: 'user-1', email: 'v@x.test', role: 'vendor_owner', exp: FUTURE + n }), refreshToken: `brt-${n}` };
        }
        throw new Error(`unexpected ${method} ${path}`);
      });
      return refreshCalls;
    }
    const refresh = (refreshToken: string, clientId: string, extra: Record<string, string> = {}) =>
      tokenPost(form({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, ...extra }));

    it('answers a repeat of the same refresh with the same tokens and one backend rotation', async () => {
      const { clientId, refreshToken } = await tokensFor();
      const calls = rotatingBackend();
      const first = await (await refresh(refreshToken, clientId)).json();
      const again = await refresh(refreshToken, clientId);
      expect(again.status).toBe(200);
      const second = await again.json();
      expect(second.access_token).toBe(first.access_token);
      expect(second.refresh_token).toBe(first.refresh_token);
      expect(calls).toHaveBeenCalledTimes(1);
      // The new refresh token is a fresh grant of its own: it rotates normally.
      await refresh(first.refresh_token, clientId);
      expect(calls).toHaveBeenCalledTimes(2);
    });

    it('lets concurrent repeats wait for the rotation already in flight', async () => {
      const { clientId, refreshToken } = await tokensFor();
      const calls = rotatingBackend();
      const answers = await Promise.all([refresh(refreshToken, clientId), refresh(refreshToken, clientId), refresh(refreshToken, clientId)]);
      const bodies = await Promise.all(answers.map((r) => r.json()));
      expect(new Set(bodies.map((b) => b.access_token)).size).toBe(1);
      expect(calls).toHaveBeenCalledTimes(1);
    });

    it('keeps nothing from a failed rotation, so a retry reaches the backend again', async () => {
      const { clientId, refreshToken } = await tokensFor();
      const { BackendApiError } = jest.requireMock('../../src/lib/backend-client');
      mockBackendRequest.mockRejectedValueOnce(new BackendApiError(503, 'down'));
      const failed = await refresh(refreshToken, clientId);
      expect(failed.status).toBe(503);
      expect((await failed.json()).error).toBe('temporarily_unavailable');
      const calls = rotatingBackend();
      expect((await refresh(refreshToken, clientId)).status).toBe(200);
      expect(calls).toHaveBeenCalledTimes(1);
    });

    it('keys the grace on the requested scope, and expires with the window', async () => {
      const { clientId, refreshToken } = await tokensFor();
      const calls = rotatingBackend();
      await refresh(refreshToken, clientId);
      await refresh(refreshToken, clientId, { scope: 'listings' });
      expect(calls).toHaveBeenCalledTimes(2);

      const later = Date.now() + (REFRESH_GRACE_S + 1) * 1000;
      jest.spyOn(Date, 'now').mockReturnValue(later);
      await refresh(refreshToken, clientId);
      expect(calls).toHaveBeenCalledTimes(3);
    });

    it('counts expires_in from the original issue when it replays an answer', async () => {
      const { clientId, refreshToken } = await tokensFor();
      rotatingBackend();
      const first = await (await refresh(refreshToken, clientId)).json();
      const realNow = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(realNow + 30_000);
      const replayed = await (await refresh(refreshToken, clientId)).json();
      expect(replayed.expires_in).toBeLessThanOrEqual(first.expires_in - 29);
      expect(replayed.expires_in).toBeGreaterThan(0);
    });

    describe('with a shared store', () => {
      const store = new Map<string, string>();
      beforeEach(() => {
        store.clear();
        process.env.UPSTASH_REDIS_REST_URL = 'https://store.test';
        process.env.UPSTASH_REDIS_REST_TOKEN = 'store-token';
        (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async (_url: string, init: RequestInit) => {
          const command = JSON.parse(init.body as string) as string[];
          const [name, key, value] = command;
          if (name === 'SET' && command.includes('NX')) {
            // The authorization-code replay cache.
            const created = !store.has(key);
            if (created) store.set(key, '1');
            return { ok: true, status: 200, text: async () => JSON.stringify({ result: created ? 'OK' : null }) };
          }
          if (name === 'SET') { store.set(key, value); return { ok: true, status: 200, text: async () => JSON.stringify({ result: 'OK' }) }; }
          if (name === 'GET') return { ok: true, status: 200, text: async () => JSON.stringify({ result: store.get(key) ?? null }) };
          return { ok: true, status: 200, text: async () => JSON.stringify({ result: null }) };
        });
      });

      it('answers a repeat that lands on another instance from the store, which holds only ciphertext', async () => {
        const { clientId, refreshToken } = await tokensFor();
        const calls = rotatingBackend();
        const first = await (await refresh(refreshToken, clientId)).json();
        const kept = [...store.entries()].filter(([k]) => k.startsWith('mcp:rtg:'));
        expect(kept).toHaveLength(1);
        const [, blob] = kept[0];
        expect(blob).not.toContain('smg_at.');
        expect(blob).not.toContain(first.access_token.slice(7, 40));
        expect(Buffer.from(blob, 'base64url').toString('utf8')).not.toContain('access_token');

        _resetRefreshGraceForTests(); // a different serverless instance: no local memory
        const second = await (await refresh(refreshToken, clientId)).json();
        expect(second.access_token).toBe(first.access_token);
        expect(calls).toHaveBeenCalledTimes(1);
      });

      it('cannot be read back without the presented refresh token', async () => {
        const { clientId, refreshToken } = await tokensFor();
        rotatingBackend();
        await refresh(refreshToken, clientId);
        // Point the kept ciphertext at a different refresh token's id: it must not decrypt.
        const other = await tokensFor();
        const calls = rotatingBackend();
        const [, blob] = [...store.entries()].find(([k]) => k.startsWith('mcp:rtg:'))!;
        _resetRefreshGraceForTests();
        await refresh(other.refreshToken, other.clientId); // creates its own entry
        const otherKey = [...store.keys()].filter((k) => k.startsWith('mcp:rtg:')).find((k) => store.get(k) !== blob)!;
        store.set(otherKey, blob);
        _resetRefreshGraceForTests();
        const res = await refresh(other.refreshToken, other.clientId);
        expect(res.status).toBe(200);
        // Undecryptable entry = no replay: it rotated at the backend again.
        expect(calls).toHaveBeenCalledTimes(2);
      });
    });
  });
});
