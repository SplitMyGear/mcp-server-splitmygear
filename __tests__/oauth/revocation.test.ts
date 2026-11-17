/**
 * SPLIT-1889: revoking an OAuth connection (RFC 7009) stops its access tokens
 * at once, whichever token is presented to /oauth/revoke.
 *
 * Before, only a refresh token did anything (a backend logout), and the
 * access token kept working until it expired, about 15 minutes later.
 */
export {};

const mockBackendRequest = jest.fn();
jest.mock('../../src/lib/backend-client', () => {
  class BackendApiError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.name = 'BackendApiError'; this.status = status; }
  }
  return { BackendApiError, backendRequest: (...args: unknown[]) => mockBackendRequest(...args), backendBaseUrl: () => 'http://backend.test/api/v1' };
});
// The budgets are stubbed open: this suite is about revocation.
jest.mock('@/middleware/rate-limit', () => ({
  claimAuthAttempt: jest.fn().mockResolvedValue({ success: true, refund: async () => undefined }),
  rateLimiter: jest.fn().mockResolvedValue({ success: true, remaining: 5 }),
  toolCallRateLimiter: jest.fn().mockResolvedValue({ success: true }),
  countToolCalls: jest.fn().mockReturnValue(0),
}));

import { POST as register } from '../../src/app/oauth/register/route';
import { POST as tokenPost } from '../../src/app/oauth/token/route';
import { POST as revokePost } from '../../src/app/oauth/revoke/route';
import { POST as mcpPost } from '../../src/app/api/mcp/route';
import { grantIdOf, issueTokens, openRefreshToken, refreshRevocationTtlS, REFRESH_TOKEN_TTL_S } from '../../src/lib/oauth/tokens';
import { _resetRevocationsForTests, isGrantRevoked } from '../../src/lib/oauth/revocation';
import { BackendApiError } from '../../src/lib/backend-client';

const KEY = 'unit-test-signing-key-with-at-least-32-bytes!!';
const BASE = 'https://mcp.test';
const REDIRECT = 'https://client.example/callback';

let seq = 0;
function backendJwt(): string {
  const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg({ sub: 'user-1', email: 'r@x.test', role: 'renter', iat: now, exp: now + 900, n: seq++ })}.sig`;
}

function form(body: Record<string, string>, path: string): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'TestClient/1' },
    body: new URLSearchParams(body).toString(),
  });
}

function mcp(accessToken: string): any {
  const req = new Request(`${BASE}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  }) as any;
  req.nextUrl = { pathname: '/api/mcp' };
  return req;
}

async function registerClient(): Promise<string> {
  const res = await register(new Request(`${BASE}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test Client', redirect_uris: [REDIRECT] }),
  }));
  return (await res.json()).client_id;
}

/** A fresh connection, as the authorization_code grant would issue it. */
function connect(clientId: string) {
  const tokens = issueTokens({
    clientId,
    user: { id: 'user-1', role: 'renter', email: 'r@x.test' },
    backendAccessToken: backendJwt(),
    backendRefreshToken: `brt-${seq++}`,
    scopes: ['read', 'profile'],
  });
  if (!tokens) throw new Error('could not issue tokens');
  return tokens;
}

const revoke = (token: string, clientId: string) => revokePost(form({ token, client_id: clientId }, '/oauth/revoke'));
const refresh = (refreshToken: string, clientId: string) => tokenPost(form({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }, '/oauth/token'));

describe('revoking a connection stops its access tokens (SPLIT-1889)', () => {
  let clientId: string;

  beforeEach(async () => {
    process.env.MCP_OAUTH_SIGNING_KEY = KEY;
    process.env.MCP_PUBLIC_URL = BASE;
    process.env.MCP_OAUTH_ALLOWED_REDIRECT_HOSTS = 'client.example';
    mockBackendRequest.mockReset();
    mockBackendRequest.mockImplementation((_method: string, path: string) => {
      if (path === '/auth/refresh') return Promise.resolve({ accessToken: backendJwt(), refreshToken: `brt-${seq++}` });
      return Promise.resolve({});
    });
    clientId = await registerClient();
  });

  afterEach(() => {
    delete process.env.MCP_OAUTH_SIGNING_KEY;
    delete process.env.MCP_PUBLIC_URL;
    delete process.env.MCP_OAUTH_ALLOWED_REDIRECT_HOSTS;
  });

  it('revoke by REFRESH token: the access token is rejected right away, and the backend session is logged out', async () => {
    const conn = connect(clientId);
    expect((await mcpPost(mcp(conn.access_token))).status).toBe(200);

    expect((await revoke(conn.refresh_token, clientId)).status).toBe(200);
    expect(mockBackendRequest.mock.calls.map((c) => c[1])).toEqual(['/auth/refresh', '/auth/logout']);

    const after = await mcpPost(mcp(conn.access_token));
    expect(after.status).toBe(401);
    expect(after.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('revoke by ACCESS token: that token and the rest of the grant stop, and the grant cannot be refreshed', async () => {
    const conn = connect(clientId);
    expect((await revoke(conn.access_token, clientId)).status).toBe(200);
    expect((await mcpPost(mcp(conn.access_token))).status).toBe(401);

    const refreshed = await refresh(conn.refresh_token, clientId);
    expect(refreshed.status).toBe(400);
    expect((await refreshed.json()).error).toBe('invalid_grant');
    expect(mockBackendRequest).not.toHaveBeenCalledWith('POST', '/auth/refresh', expect.anything());
  });

  it('access tokens issued before a refresh are revoked with the grant (the grant id survives rotation)', async () => {
    const conn = connect(clientId);
    const res = await refresh(conn.refresh_token, clientId);
    expect(res.status).toBe(200);
    const rotated = await res.json();
    expect((await mcpPost(mcp(conn.access_token))).status).toBe(200);
    expect((await mcpPost(mcp(rotated.access_token))).status).toBe(200);

    await revoke(rotated.refresh_token, clientId);
    expect((await mcpPost(mcp(rotated.access_token))).status).toBe(401);
    expect((await mcpPost(mcp(conn.access_token))).status).toBe(401);
  });

  it('other connections of the same user are untouched', async () => {
    const revoked = connect(clientId);
    const other = connect(clientId);
    await revoke(revoked.refresh_token, clientId);
    expect((await mcpPost(mcp(other.access_token))).status).toBe(200);
  });

  it("a client cannot revoke another client's token, and unknown tokens still answer 200 (RFC 7009 §2.2)", async () => {
    const conn = connect(clientId);
    const stranger = await registerClient();
    expect((await revoke(conn.access_token, stranger)).status).toBe(200);
    expect((await revoke(conn.refresh_token, stranger)).status).toBe(200);
    expect((await mcpPost(mcp(conn.access_token))).status).toBe(200);
    expect((await revoke('smg_at.not-a-token', clientId)).status).toBe(200);
  });
});

describe('revocation across instances through the shared store (SPLIT-1889)', () => {
  const mockFetch = jest.fn();
  const realFetch = global.fetch;
  const store = new Map<string, string>();
  let clientId: string;

  beforeEach(async () => {
    process.env.MCP_OAUTH_SIGNING_KEY = KEY;
    process.env.MCP_PUBLIC_URL = BASE;
    process.env.MCP_OAUTH_ALLOWED_REDIRECT_HOSTS = 'client.example';
    process.env.UPSTASH_REDIS_REST_URL = 'https://store.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'store-token';
    store.clear();
    mockFetch.mockReset();
    // A tiny Upstash stand-in: single commands only (SET ... EX, GET).
    mockFetch.mockImplementation(async (_url: string, init: { body: string }) => {
      const [cmd, key, value] = JSON.parse(init.body) as string[];
      if (cmd === 'SET') store.set(key, value);
      const result = cmd === 'SET' ? 'OK' : store.get(key) ?? null;
      return { ok: true, status: 200, text: async () => JSON.stringify({ result }) };
    });
    (global as unknown as { fetch: jest.Mock }).fetch = mockFetch;
    mockBackendRequest.mockReset();
    mockBackendRequest.mockResolvedValue({});
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    clientId = await registerClient();
  });

  afterEach(() => {
    (global as unknown as { fetch: typeof realFetch }).fetch = realFetch;
    (console.warn as jest.Mock).mockRestore();
    for (const k of ['MCP_OAUTH_SIGNING_KEY', 'MCP_PUBLIC_URL', 'MCP_OAUTH_ALLOWED_REDIRECT_HOSTS', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[k];
  });

  const storeGets = () => mockFetch.mock.calls.filter((c) => JSON.parse(c[1].body)[0] === 'GET');

  it('records the grant with a TTL of one access-token lifetime and costs one store read per MCP request', async () => {
    const conn = connect(clientId);
    mockFetch.mockClear();
    expect((await mcpPost(mcp(conn.access_token))).status).toBe(200);
    expect(storeGets()).toHaveLength(1);

    await revoke(conn.access_token, clientId);
    const set = mockFetch.mock.calls.map((c) => JSON.parse(c[1].body)).find((cmd) => cmd[0] === 'SET');
    expect(set[1]).toMatch(/^mcp:revoked:/);
    expect(set.slice(3)).toEqual(['EX', 900]);
  });

  it('another instance (no local record) rejects the revoked token from the store; an unreachable store fails open', async () => {
    const conn = connect(clientId);
    await revoke(conn.access_token, clientId);
    // Simulate a different serverless instance: forget the local record.
    _resetRevocationsForTests();
    expect((await mcpPost(mcp(conn.access_token))).status).toBe(401);

    mockFetch.mockRejectedValue(new TypeError('fetch failed'));
    expect((await mcpPost(mcp(conn.access_token))).status).toBe(200);
  });
});

describe('revoking a refresh token never silently lapses (SPLIT-1921)', () => {
  let clientId: string;
  const realFetch = global.fetch;
  const mockFetch = jest.fn();
  const store = new Map<string, string>();

  beforeEach(async () => {
    process.env.MCP_OAUTH_SIGNING_KEY = KEY;
    process.env.MCP_PUBLIC_URL = BASE;
    process.env.MCP_OAUTH_ALLOWED_REDIRECT_HOSTS = 'client.example';
    _resetRevocationsForTests();
    mockBackendRequest.mockReset();
    clientId = await registerClient();
  });

  afterEach(() => {
    (global as unknown as { fetch: typeof realFetch }).fetch = realFetch;
    for (const k of ['MCP_OAUTH_SIGNING_KEY', 'MCP_PUBLIC_URL', 'MCP_OAUTH_ALLOWED_REDIRECT_HOSTS', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[k];
  });

  const grantOf = (refreshToken: string) => grantIdOf(openRefreshToken(refreshToken)!);
  const backendPaths = () => mockBackendRequest.mock.calls.map((c) => c[1]);
  const freshSession = () => ({ accessToken: backendJwt(), refreshToken: `brt-${seq++}` });

  it('backend refresh times out: 503 temporarily_unavailable with Retry-After, grant already recorded', async () => {
    const conn = connect(clientId);
    mockBackendRequest.mockRejectedValue(new Error('The operation was aborted due to timeout'));
    const res = await revoke(conn.refresh_token, clientId);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('temporarily_unavailable');
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(await isGrantRevoked(grantOf(conn.refresh_token))).toBe(true);
    expect((await mcpPost(mcp(conn.access_token))).status).toBe(401);
  });

  it.each([500, 502, 429])('backend refresh answers %i: 503, grant recorded', async (status) => {
    const conn = connect(clientId);
    mockBackendRequest.mockRejectedValue(new BackendApiError(status, 'boom'));
    const res = await revoke(conn.refresh_token, clientId);
    expect(res.status).toBe(503);
    expect(await isGrantRevoked(grantOf(conn.refresh_token))).toBe(true);
  });

  it.each([400, 401, 403])('backend refresh answers %i (token not valid): nothing left to revoke, 200', async (status) => {
    const conn = connect(clientId);
    mockBackendRequest.mockRejectedValue(new BackendApiError(status, 'invalid token'));
    const res = await revoke(conn.refresh_token, clientId);
    expect(res.status).toBe(200);
    expect(await isGrantRevoked(grantOf(conn.refresh_token))).toBe(true);
  });

  it('happy path: refresh then logout once, 200', async () => {
    const conn = connect(clientId);
    mockBackendRequest.mockImplementation((_m: string, path: string) => Promise.resolve(path === '/auth/refresh' ? freshSession() : {}));
    expect((await revoke(conn.refresh_token, clientId)).status).toBe(200);
    expect(backendPaths()).toEqual(['/auth/refresh', '/auth/logout']);
  });

  it('refresh ok but logout fails twice: logout retried once, then 503 (the rotated token is held by no one else)', async () => {
    const conn = connect(clientId);
    mockBackendRequest.mockImplementation((_m: string, path: string) =>
      path === '/auth/refresh' ? Promise.resolve(freshSession()) : Promise.reject(new BackendApiError(500, 'down')));
    const res = await revoke(conn.refresh_token, clientId);
    expect(res.status).toBe(503);
    expect(backendPaths()).toEqual(['/auth/refresh', '/auth/logout', '/auth/logout']);
    expect(await isGrantRevoked(grantOf(conn.refresh_token))).toBe(true);
  });

  it('refresh ok, first logout fails, the retry lands: 200', async () => {
    const conn = connect(clientId);
    let logouts = 0;
    mockBackendRequest.mockImplementation((_m: string, path: string) => {
      if (path === '/auth/refresh') return Promise.resolve(freshSession());
      return ++logouts === 1 ? Promise.reject(new BackendApiError(500, 'blip')) : Promise.resolve({});
    });
    expect((await revoke(conn.refresh_token, clientId)).status).toBe(200);
    expect(logouts).toBe(2);
  });

  it('access-token revoke is unchanged: no backend call, one access lifetime, 200', async () => {
    const conn = connect(clientId);
    expect((await revoke(conn.access_token, clientId)).status).toBe(200);
    expect(mockBackendRequest).not.toHaveBeenCalled();
  });

  it('the grant record for a refresh-token revoke lasts the refresh token\'s remaining lifetime', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://store.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'store-token';
    store.clear();
    mockFetch.mockReset();
    mockFetch.mockImplementation(async (_url: string, init: { body: string }) => {
      const [cmd, key, value] = JSON.parse(init.body) as string[];
      if (cmd === 'SET') store.set(key, value);
      return { ok: true, status: 200, text: async () => JSON.stringify({ result: cmd === 'SET' ? 'OK' : store.get(key) ?? null }) };
    });
    (global as unknown as { fetch: jest.Mock }).fetch = mockFetch;
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const conn = connect(clientId);
    mockBackendRequest.mockImplementation((_m: string, path: string) => Promise.resolve(path === '/auth/refresh' ? freshSession() : {}));
    mockFetch.mockClear();
    await revoke(conn.refresh_token, clientId);
    (console.warn as jest.Mock).mockRestore();
    const set = mockFetch.mock.calls.map((c) => JSON.parse(c[1].body)).find((cmd) => cmd[0] === 'SET');
    expect(set[1]).toMatch(/^mcp:revoked:/);
    expect(set[3]).toBe('EX');
    // Issued just now, so the remaining life is the full 30 days (allow clock tick).
    expect(set[4]).toBeGreaterThan(REFRESH_TOKEN_TTL_S - 5);
    expect(set[4]).toBeLessThanOrEqual(REFRESH_TOKEN_TTL_S);
  });

  it('refreshRevocationTtlS: remaining life, floored at the access record, capped at the refresh ceiling', () => {
    const now = 1_000_000;
    expect(refreshRevocationTtlS({ atl: 900, exp: now + 10 * 24 * 3600 }, now)).toBe(10 * 24 * 3600);
    expect(refreshRevocationTtlS({ atl: 900, exp: now + 60 }, now)).toBe(900);
    expect(refreshRevocationTtlS({ atl: 900, exp: now - 5 }, now)).toBe(900);
    expect(refreshRevocationTtlS({ atl: 900, exp: now + 90 * 24 * 3600 }, now)).toBe(REFRESH_TOKEN_TTL_S);
    expect(refreshRevocationTtlS({ exp: Number.NaN }, now)).toBe(900);
  });
});
