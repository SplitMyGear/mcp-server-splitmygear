/**
 * SPLIT-1621: the canonical path of the MCP endpoint is configurable per
 * deployment (`MCP_RESOURCE_PATH`), so production can advertise `/mcp` while
 * every other deployment keeps `/api/mcp`. Both paths are ALWAYS live
 * (src/app/mcp/route.ts and src/app/api/mcp/route.ts are the same handler);
 * only which one is CANONICAL changes.
 *
 * The unset (default) behavior is pinned unchanged by the existing suites
 * (compat.test.ts, flow.test.ts, mcp-route.test.ts) — this file covers the
 * `/mcp` configuration: resourceUrl(), the protected-resource metadata at
 * both well-known locations, the WWW-Authenticate challenge on both endpoint
 * paths, isOwnResource's stricter accept set, the authorize/token
 * invalid_target message, invalid-value handling, and that key derivation
 * does not depend on the path.
 */
export {};
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const mockBackendRequest = jest.fn();
jest.mock('../../src/lib/backend-client', () => {
  class BackendApiError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.name = 'BackendApiError'; this.status = status; }
  }
  return { BackendApiError, backendRequest: (...args: unknown[]) => mockBackendRequest(...args), backendBaseUrl: () => 'http://backend.test/api/v1' };
});
// This suite is about the resource path, not the transport or the rate
// limiter (which has its own suites); both budgets are stubbed open.
jest.mock('@/middleware/rate-limit', () => ({
  rateLimiter: jest.fn().mockResolvedValue({ success: true, remaining: 5 }),
  toolCallRateLimiter: jest.fn().mockResolvedValue({ success: true }),
  countToolCalls: jest.fn().mockReturnValue(0),
}));

import { mcpResourcePath, resourceUrl, isOwnResource, deriveKey, MCP_RESOURCE_PATHS, _resetOAuthConfigForTests } from '../../src/lib/oauth/config';
import { protectedResourceMetadata } from '../../src/lib/oauth/metadata';
import { GET as prmGet } from '../../src/app/.well-known/oauth-protected-resource/[[...path]]/route';
import { GET as asGet } from '../../src/app/.well-known/oauth-authorization-server/[[...path]]/route';
import { POST as apiMcpPost } from '../../src/app/api/mcp/route';
import { POST as mcpPost } from '../../src/app/mcp/route';
import { POST as register } from '../../src/app/oauth/register/route';
import { GET as authorizeGet, POST as authorizePost } from '../../src/app/oauth/authorize/route';
import { POST as tokenPost } from '../../src/app/oauth/token/route';
import { _resetThrottle } from '../../src/lib/oauth/throttle';
import { _resetSharedStoreForTests } from '../../src/lib/shared-store';

const KEY = 'unit-test-signing-key-with-at-least-32-bytes!!';
const BASE = 'https://mcp.test';
const HTTPS_REDIRECT = 'https://client.example/callback';

function backendJwt(payload: Record<string, unknown>): string {
  const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg(payload)}.sig`;
}
const FUTURE = Math.floor(Date.now() / 1000) + 900;
const backendAccess = backendJwt({ sub: 'user-1', email: 'r@x.test', role: 'renter', exp: FUTURE });

function form(body: Record<string, string>, url = `${BASE}/oauth/token`): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE, 'sec-fetch-site': 'same-origin', 'user-agent': 'TestClient/1' },
    body: new URLSearchParams(body).toString(),
  });
}
async function registerClient(): Promise<string> {
  const res = await register(new Request(`${BASE}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Test Client', redirect_uris: [HTTPS_REDIRECT] }) }));
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
      return { accessToken: backendAccess, refreshToken: 'brt-1', user: { id: 'user-1', email: 'r@x.test', role: 'renter' } };
    }
    if (method === 'GET' && path === '/auth/providers') return { google: false, apple: false };
    throw new Error(`unexpected ${method} ${path}`);
  });
}
/** Drive authorize (GET + password POST) and return the redirect Location. */
async function signIn(clientId: string, redirectUri: string, extra: Record<string, string> = {}): Promise<{ location: URL; verifier: string }> {
  const { verifier, challenge } = pkce();
  loginSucceeds();
  const page = await authorizeGet(new Request(authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state: 's1', code_challenge: challenge, code_challenge_method: 'S256', ...extra })));
  expect(page.status).toBe(200);
  const res = await authorizePost(form({ step: 'login', req: hidden(await page.text(), 'req'), email: 'r@x.test', password: 'pw' }, `${BASE}/oauth/authorize`));
  expect(res.status).toBe(302);
  return { location: new URL(res.headers.get('location')!), verifier };
}

/** An unauthenticated MCP request (no credentials), for challenge assertions. */
function mcpRequest(url: string): any {
  const req = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  }) as any;
  req.nextUrl = { pathname: new URL(url).pathname };
  return req;
}

describe('MCP_RESOURCE_PATH (SPLIT-1621)', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.MCP_OAUTH_SIGNING_KEY = KEY;
    process.env.MCP_PUBLIC_URL = BASE;
    process.env.MCP_OAUTH_ALLOWED_REDIRECT_HOSTS = 'client.example';
    _resetThrottle();
    _resetSharedStoreForTests();
    _resetOAuthConfigForTests();
    mockBackendRequest.mockReset();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const name of ['MCP_OAUTH_SIGNING_KEY', 'MCP_PUBLIC_URL', 'MCP_OAUTH_ALLOWED_REDIRECT_HOSTS', 'MCP_RESOURCE_PATH']) delete process.env[name];
    _resetOAuthConfigForTests();
    jest.restoreAllMocks();
  });

  it('defaults to /api/mcp when unset, unchanged from before SPLIT-1621', () => {
    expect(mcpResourcePath()).toBe('/api/mcp');
    expect(resourceUrl()).toBe(`${BASE}/api/mcp`);
  });

  describe("MCP_RESOURCE_PATH='/mcp' (production)", () => {
    beforeEach(() => {
      process.env.MCP_RESOURCE_PATH = '/mcp';
    });

    it('resourceUrl() names the /mcp endpoint', () => {
      expect(mcpResourcePath()).toBe('/mcp');
      expect(resourceUrl()).toBe(`${BASE}/mcp`);
    });

    it('the protected-resource metadata body names /mcp', () => {
      expect(protectedResourceMetadata(BASE).resource).toBe(`${BASE}/mcp`);
    });

    it('is served at both path-aware well-known locations, always naming the canonical resource', async () => {
      const atMcp = await (
        await prmGet(new Request(`${BASE}/.well-known/oauth-protected-resource/mcp`), { params: Promise.resolve({ path: ['mcp'] }) })
      ).json();
      expect(atMcp.resource).toBe(`${BASE}/mcp`);

      // Probed at the NON-canonical suffix (a client still configured for the
      // old path): still answers, and still names the canonical resource.
      const atApiMcp = await (
        await prmGet(new Request(`${BASE}/.well-known/oauth-protected-resource/api/mcp`), { params: Promise.resolve({ path: ['api', 'mcp'] }) })
      ).json();
      expect(atApiMcp.resource).toBe(`${BASE}/mcp`);

      const atRoot = await (
        await prmGet(new Request(`${BASE}/.well-known/oauth-protected-resource`), { params: Promise.resolve({ path: [] as string[] }) })
      ).json();
      expect(atRoot.resource).toBe(`${BASE}/mcp`);

      const other = await prmGet(new Request(`${BASE}/.well-known/oauth-protected-resource/other`), { params: Promise.resolve({ path: ['other'] }) });
      expect(other.status).toBe(404);
    });

    it('advertises the /mcp well-known location in the 401 challenge, identically on both endpoint paths', async () => {
      const viaApi = await apiMcpPost(mcpRequest(`${BASE}/api/mcp`));
      const viaMcp = await mcpPost(mcpRequest(`${BASE}/mcp`));
      expect(viaApi.status).toBe(401);
      expect(viaMcp.status).toBe(401);
      const expected = `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`;
      expect(viaApi.headers.get('www-authenticate')).toBe(expected);
      expect(viaMcp.headers.get('www-authenticate')).toBe(expected);
    });

    describe('isOwnResource', () => {
      it('accepts the canonical endpoint and the bare origin, with or without a trailing slash', () => {
        for (const value of [`${BASE}/mcp`, `${BASE}/mcp/`, BASE, `${BASE}/`]) {
          expect(isOwnResource(value)).toBe(true);
        }
      });

      it('rejects /api/mcp now that /mcp is canonical, even though /api/mcp is still a live endpoint', () => {
        expect(isOwnResource(`${BASE}/api/mcp`)).toBe(false);
        expect(isOwnResource(`${BASE}/api/mcp/`)).toBe(false);
      });
    });

    describe('authorize/token invalid_target', () => {
      it('names the canonical /mcp resource in the error, and rejects a resource of /api/mcp', async () => {
        const clientId = await registerClient();
        const { challenge } = pkce();

        const badAuthorize = await authorizeGet(
          new Request(authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: HTTPS_REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', resource: `${BASE}/api/mcp` })),
        );
        const location = new URL(badAuthorize.headers.get('location')!);
        expect(location.searchParams.get('error')).toBe('invalid_target');
        expect(location.searchParams.get('error_description')).toBe(`resource must be ${BASE}/mcp`);

        const { location: okLocation, verifier } = await signIn(clientId, HTTPS_REDIRECT);
        const badToken = await tokenPost(
          form({ grant_type: 'authorization_code', code: okLocation.searchParams.get('code')!, code_verifier: verifier, redirect_uri: HTTPS_REDIRECT, client_id: clientId, resource: `${BASE}/api/mcp` }),
        );
        const body = await badToken.json();
        expect(body.error).toBe('invalid_target');
        expect(body.error_description).toBe(`resource must be ${BASE}/mcp`);
      });

      it('accepts a resource of exactly /mcp at both authorize and token', async () => {
        const clientId = await registerClient();
        const { location, verifier } = await signIn(clientId, HTTPS_REDIRECT, { resource: `${BASE}/mcp` });
        const token = await tokenPost(
          form({ grant_type: 'authorization_code', code: location.searchParams.get('code')!, code_verifier: verifier, redirect_uri: HTTPS_REDIRECT, client_id: clientId, resource: `${BASE}/mcp` }),
        );
        expect(token.status).toBe(200);
      });
    });
  });

  describe('invalid MCP_RESOURCE_PATH values fail closed to /api/mcp', () => {
    it('logs the bad value once per cold instance, not on every call', () => {
      process.env.MCP_RESOURCE_PATH = '/mcp/'; // trailing slash: not an exact match
      expect(mcpResourcePath()).toBe('/api/mcp');
      expect(mcpResourcePath()).toBe('/api/mcp');
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0][0])).toContain('MCP_RESOURCE_PATH');
      expect(String(errorSpy.mock.calls[0][0])).toContain('/mcp/');
    });

    it.each(['mcp', 'API/MCP', '/MCP', '//mcp', ''])('rejects %j (not one of the two exact values)', (bad) => {
      process.env.MCP_RESOURCE_PATH = bad;
      expect(mcpResourcePath()).toBe('/api/mcp');
    });
  });

  // Older MCP clients probe the path-aware authorization-server metadata using
  // the RESOURCE path, and on production that is /mcp. The document has no
  // path of its own (the issuer is the bare origin), so every suffix that names
  // a live resource path returns the SAME body; anything else is not ours.
  describe.each([[undefined], ['/mcp']])('authorization-server metadata catch-all (MCP_RESOURCE_PATH=%s)', (configured) => {
    beforeEach(() => {
      if (configured) process.env.MCP_RESOURCE_PATH = configured;
    });
    const at = (path: string[]) =>
      asGet(new Request(`${BASE}/.well-known/oauth-authorization-server/${path.join('/')}`), { params: Promise.resolve({ path }) });

    it('answers the root, mcp and api/mcp with the same document', async () => {
      const root = await at([]);
      const viaMcp = await at(['mcp']);
      const viaApiMcp = await at(['api', 'mcp']);
      for (const res of [root, viaMcp, viaApiMcp]) expect(res.status).toBe(200);
      const body = await root.json();
      expect(body.issuer).toBe(BASE);
      expect(await viaMcp.json()).toEqual(body);
      expect(await viaApiMcp.json()).toEqual(body);
    });

    it('answers 404 for any other suffix', async () => {
      for (const path of [['other'], ['api'], ['mcp', 'extra'], ['api', 'mcp', 'extra'], ['MCP']]) {
        expect((await at(path)).status).toBe(404);
      }
    });
  });

  // The route file is what serves a path; vercel.json is what gives its
  // function the MCP endpoint's 60 s budget (Next reads only `dynamic` from
  // the file itself). A path served without its entry would silently run on the
  // platform default, so this pins every served path to the same duration.
  describe('every served path is a route file with the same maxDuration', () => {
    const ROOT = path.join(__dirname, '..', '..');
    const functions = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')).functions as Record<string, { maxDuration?: number }>;
    const routeFile = (p: string) => `src/app${p}/route.ts`;

    it.each([...MCP_RESOURCE_PATHS])('%s has a route file and a vercel.json entry', (p) => {
      const file = routeFile(p);
      expect(fs.existsSync(path.join(ROOT, file))).toBe(true);
      expect(fs.readFileSync(path.join(ROOT, file), 'utf8')).toContain("export const dynamic = 'force-dynamic';");
      expect(functions[file]?.maxDuration).toBe(60);
    });

    it('gives both paths an identical function configuration', () => {
      const [a, b] = MCP_RESOURCE_PATHS.map((p) => functions[routeFile(p)]);
      expect(b).toEqual(a);
    });
  });

  it('key derivation depends only on MCP_PUBLIC_URL, never on the resource path', () => {
    delete process.env.MCP_RESOURCE_PATH;
    const withDefault = deriveKey('split-1621-test-purpose');
    process.env.MCP_RESOURCE_PATH = '/mcp';
    const withMcp = deriveKey('split-1621-test-purpose');
    expect(withMcp.equals(withDefault)).toBe(true);
  });
});
