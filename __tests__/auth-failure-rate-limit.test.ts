/**
 * SPLIT-1888: failed authentication is rate limited per client IP BEFORE the
 * credential is checked.
 *
 * Before, the route authenticated first and only then charged the
 * per-principal budget, so a wrong operator key was never answered 429 and
 * every forged raw JWT bought one backend `GET /users/profile` (lib/jwt.ts
 * verifyWithBackend, the path taken when MCP_BACKEND_JWT_SECRET is unset, as
 * in production). These cases run the REAL limiter and the REAL route; only
 * the backend is mocked, so its call count is the amplification an attacker
 * gets.
 */
export {};

const mockBackendRequest = jest.fn();
jest.mock('@/lib/backend-client', () => {
  class BackendApiError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.name = 'BackendApiError'; this.status = status; }
  }
  return { BackendApiError, backendRequest: (...args: unknown[]) => mockBackendRequest(...args), backendBaseUrl: () => 'http://backend.test/api/v1' };
});

import { NextRequest } from 'next/server';
import { POST } from '../src/app/api/mcp/route';
import { AUTH_FAILURES_PER_MINUTE, RATE_LIMITS, claimAuthAttempt } from '../src/middleware/rate-limit';

const OPERATOR_KEY = 'test-operator-key';
const VALID_JWT_SUB = 'real-user';
const FAILURE_LIMIT = 5;
const REQUEST_LIMIT = RATE_LIMITS.default.requestsPerMinute; // 10

const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const exp = () => Math.floor(Date.now() / 1000) + 3600;
let forgedSeq = 0;
/** A JWT-shaped bearer with a unique `sub` and a junk signature, like forge.js in the review. */
const forgedJwt = () => `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg({ sub: `forged-${forgedSeq++}`, typ: 'access', exp: exp() })}.${Buffer.from('junk').toString('base64url')}`;
const validJwt = () => `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg({ sub: VALID_JWT_SUB, typ: 'access', exp: exp(), n: forgedSeq++ })}.c2ln`;

const TOOLS_LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

function mcpRequest(ip: string, headers: Record<string, string>): NextRequest {
  const req = new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-forwarded-for': ip, ...headers },
    body: JSON.stringify(TOOLS_LIST),
  }) as NextRequest;
  Object.defineProperty(req, 'nextUrl', { value: { pathname: '/api/mcp' } });
  return req;
}

const profileCalls = () => mockBackendRequest.mock.calls.filter((c) => c[1] === '/users/profile').length;

async function statuses(n: number, make: () => NextRequest): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await POST(make())).status);
  return out;
}

let ipSeq = 1;
const freshIp = () => `198.51.100.${ipSeq++}`;

beforeAll(() => { jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterAll(() => { (console.warn as jest.Mock).mockRestore(); });

describe('failed authentication is throttled per IP before it is checked (SPLIT-1888)', () => {
  beforeEach(() => {
    process.env.MCP_API_KEY = OPERATOR_KEY;
    process.env.MCP_TRUST_PROXY_HEADERS = '1';
    process.env.MCP_RATE_LIMIT_TIER = 'default';
    delete process.env.MCP_BACKEND_JWT_SECRET;
    mockBackendRequest.mockReset();
    mockBackendRequest.mockImplementation((_method: string, path: string, options: { token?: string }) => {
      if (path !== '/users/profile') return Promise.resolve({});
      const payload = JSON.parse(Buffer.from((options.token ?? '').split('.')[1] ?? '', 'base64url').toString() || '{}');
      if (payload.sub === VALID_JWT_SUB) return Promise.resolve({ id: VALID_JWT_SUB, role: 'renter' });
      const { BackendApiError } = jest.requireMock('@/lib/backend-client') as { BackendApiError: new (s: number, m: string) => Error };
      return Promise.reject(new BackendApiError(401, 'Unauthorized'));
    });
  });

  afterEach(() => {
    delete process.env.MCP_API_KEY;
    delete process.env.MCP_TRUST_PROXY_HEADERS;
    delete process.env.MCP_RATE_LIMIT_TIER;
  });

  it('has a failure budget stricter than the request budget', () => {
    expect(AUTH_FAILURES_PER_MINUTE).toBe(FAILURE_LIMIT);
    expect(FAILURE_LIMIT).toBeLessThan(REQUEST_LIMIT);
  });

  it('a burst of forged JWTs gets 429 after the budget, and only the budgeted ones reach the backend', async () => {
    const ip = freshIp();
    const got = await statuses(20, () => mcpRequest(ip, { authorization: `Bearer ${forgedJwt()}` }));
    expect(got.slice(0, FAILURE_LIMIT)).toEqual(Array(FAILURE_LIMIT).fill(401));
    expect(got.slice(FAILURE_LIMIT)).toEqual(Array(20 - FAILURE_LIMIT).fill(429));
    expect(profileCalls()).toBe(FAILURE_LIMIT);
  });

  it('a burst of wrong operator keys gets 429 with Retry-After', async () => {
    const ip = freshIp();
    const responses = [];
    for (let i = 0; i < 12; i++) responses.push(await POST(mcpRequest(ip, { 'x-api-key': `guess-${i}` })));
    expect(responses.map((r) => r.status)).toEqual([...Array(FAILURE_LIMIT).fill(401), ...Array(12 - FAILURE_LIMIT).fill(429)]);
    const last = responses[responses.length - 1];
    expect(last.headers.get('retry-after')).toBe('60');
    expect(JSON.parse(await last.text()).error).toMatch(/failed authentication/i);
  });

  it('the budget is per IP: another address is not affected', async () => {
    const attacker = freshIp();
    await statuses(10, () => mcpRequest(attacker, { 'x-api-key': 'nope' }));
    expect((await POST(mcpRequest(freshIp(), { 'x-api-key': 'nope' }))).status).toBe(401);
    expect((await POST(mcpRequest(freshIp(), { 'x-api-key': OPERATOR_KEY }))).status).toBe(200);
  });

  it('authenticated traffic keeps its own limits and does not spend the failure budget', async () => {
    const ip = freshIp();
    // Operator key: exactly the request budget, as before, then 429 from THAT budget.
    const ok = await statuses(REQUEST_LIMIT, () => mcpRequest(ip, { 'x-api-key': OPERATOR_KEY }));
    expect(ok).toEqual(Array(REQUEST_LIMIT).fill(200));
    const over = await POST(mcpRequest(ip, { 'x-api-key': OPERATOR_KEY }));
    expect(over.status).toBe(429);
    expect(JSON.parse(await over.text()).error).toMatch(/requests per minute/);
    // Ten successes refunded their slots: the same IP still has its whole failure budget.
    const failures = await statuses(FAILURE_LIMIT, () => mcpRequest(ip, { 'x-api-key': 'wrong' }));
    expect(failures).toEqual(Array(FAILURE_LIMIT).fill(401));
  });

  it('valid raw JWTs are verified and served, without spending the failure budget', async () => {
    const ip = freshIp();
    const got = await statuses(8, () => mcpRequest(ip, { authorization: `Bearer ${validJwt()}` }));
    expect(got).toEqual(Array(8).fill(200));
    const failures = await statuses(FAILURE_LIMIT, () => mcpRequest(ip, { authorization: `Bearer ${forgedJwt()}` }));
    expect(failures).toEqual(Array(FAILURE_LIMIT).fill(401));
  });

  it('a request with no credential keeps getting its 401 challenge (OAuth discovery is never throttled here)', async () => {
    const ip = freshIp();
    const got = await statuses(15, () => mcpRequest(ip, {}));
    expect(got).toEqual(Array(15).fill(401));
    expect(profileCalls()).toBe(0);
  });
});

describe('the failure budget uses the shared store when the limiter does (SPLIT-1888)', () => {
  const mockFetch = jest.fn();
  const realFetch = global.fetch;
  let count = 0;

  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://store.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'store-token';
    process.env.MCP_TRUST_PROXY_HEADERS = '1';
    count = 0;
    mockFetch.mockReset();
    // A one-key Upstash stand-in: INCR/DECR on the pipeline endpoint.
    mockFetch.mockImplementation(async (_url: string, init: { body: string }) => {
      const [[cmd]] = JSON.parse(init.body) as [string[]];
      count += cmd === 'INCR' ? 1 : -1;
      return { ok: true, status: 200, text: async () => JSON.stringify([{ result: count }, { result: 1 }]) };
    });
    (global as unknown as { fetch: jest.Mock }).fetch = mockFetch;
  });

  afterEach(() => {
    (global as unknown as { fetch: typeof realFetch }).fetch = realFetch;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.MCP_TRUST_PROXY_HEADERS;
  });

  const commands = () => mockFetch.mock.calls.map((c) => (JSON.parse(c[1].body) as string[][])[0][0]);

  it('claims with one INCR, refunds a valid credential with one DECR, and refuses past the ceiling', async () => {
    const req = mcpRequest('203.0.113.50', { 'x-api-key': 'x' });
    const first = await claimAuthAttempt(req);
    expect(first.success).toBe(true);
    await first.refund();
    expect(commands()).toEqual(['INCR', 'DECR']);
    expect(String(mockFetch.mock.calls[0][1].body)).toContain('mcp:rl:authfail:ip:203.0.113.50:');

    for (let i = 0; i < FAILURE_LIMIT; i++) expect((await claimAuthAttempt(req)).success).toBe(true);
    expect((await claimAuthAttempt(req)).success).toBe(false);
  });
});
