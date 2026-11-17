/**
 * SPLIT-1921: the unauthenticated OAuth pages are budgeted. GET /oauth/authorize
 * and POST /oauth/register are limited per client IP, and the authorize page no
 * longer asks the backend for its social providers on every hit.
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

import crypto from 'crypto';
import { GET as authorizeGet } from '../../src/app/oauth/authorize/route';
import { POST as register } from '../../src/app/oauth/register/route';
import { _resetThrottle, PUBLIC_BUDGETS } from '../../src/lib/oauth/throttle';
import { _resetProvidersCacheForTests } from '../../src/lib/oauth/backend-auth';

const BASE = 'https://mcp.test';
const REDIRECT = 'https://client.example/callback';
const challenge = crypto.createHash('sha256').update('verifier').digest('base64url');

function registerFrom(ip: string | undefined): Promise<Response> {
  return register(new Request(`${BASE}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(ip ? { 'x-real-ip': ip } : {}) },
    body: JSON.stringify({ client_name: 'Budget Client', redirect_uris: [REDIRECT] }),
  }));
}

function authorizeFrom(clientId: string, ip: string | undefined): Promise<Response> {
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 's', code_challenge: challenge, code_challenge_method: 'S256' });
  return authorizeGet(new Request(`${BASE}/oauth/authorize?${q}`, { headers: ip ? { 'x-real-ip': ip } : {} }));
}

const providerCalls = () => mockBackendRequest.mock.calls.filter((c) => c[1] === '/auth/providers');

describe('public OAuth page budgets and providers cache (SPLIT-1921)', () => {
  let clientId: string;

  beforeEach(async () => {
    process.env.MCP_OAUTH_SIGNING_KEY = 'unit-test-signing-key-with-at-least-32-bytes!!';
    process.env.MCP_PUBLIC_URL = BASE;
    process.env.MCP_OAUTH_ALLOWED_REDIRECT_HOSTS = 'client.example';
    process.env.MCP_TRUST_PROXY_HEADERS = '1';
    _resetThrottle();
    _resetProvidersCacheForTests();
    mockBackendRequest.mockReset();
    mockBackendRequest.mockImplementation((_m: string, path: string) => (path === '/auth/providers' ? Promise.resolve({ google: true, apple: false }) : Promise.resolve({})));
    // Registered without an IP, so it spends no budget.
    clientId = (await (await registerFrom(undefined)).json()).client_id;
  });

  afterEach(() => {
    for (const k of ['MCP_OAUTH_SIGNING_KEY', 'MCP_PUBLIC_URL', 'MCP_OAUTH_ALLOWED_REDIRECT_HOSTS', 'MCP_TRUST_PROXY_HEADERS']) delete process.env[k];
  });

  describe('providers cache', () => {
    it('a second authorize GET inside the window does not ask the backend again', async () => {
      const first = await authorizeFrom(clientId, '203.0.113.1');
      const second = await authorizeFrom(clientId, '203.0.113.2');
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(providerCalls()).toHaveLength(1);
      expect(await second.text()).toContain('google');
    });

    it('asks again once the minute is up', async () => {
      const now = jest.spyOn(Date, 'now');
      const t0 = Date.now();
      now.mockReturnValue(t0);
      await authorizeFrom(clientId, '203.0.113.1');
      now.mockReturnValue(t0 + 61_000);
      await authorizeFrom(clientId, '203.0.113.1');
      now.mockRestore();
      expect(providerCalls()).toHaveLength(2);
    });

    it('a failed providers call still renders the page, and is not served from cache afterwards', async () => {
      mockBackendRequest.mockImplementation((_m: string, path: string) => (path === '/auth/providers' ? Promise.reject(new Error('timeout')) : Promise.resolve({})));
      expect((await authorizeFrom(clientId, '203.0.113.1')).status).toBe(200);

      mockBackendRequest.mockImplementation((_m: string, path: string) => (path === '/auth/providers' ? Promise.resolve({ google: true, apple: true }) : Promise.resolve({})));
      const next = await authorizeFrom(clientId, '203.0.113.1');
      expect(providerCalls()).toHaveLength(2);
      expect(await next.text()).toContain('apple');
    });
  });

  describe('POST /oauth/register', () => {
    it('the request after the budget gets a 429 JSON OAuth error; another IP is unaffected', async () => {
      const limit = PUBLIC_BUDGETS.register.max;
      for (let i = 0; i < limit; i++) expect((await registerFrom('198.51.100.7')).status).toBe(201);
      const over = await registerFrom('198.51.100.7');
      expect(over.status).toBe(429);
      expect(over.headers.get('content-type')).toContain('application/json');
      expect((await over.json()).error).toBe('temporarily_unavailable');
      expect(over.headers.get('retry-after')).toBeTruthy();
      expect((await registerFrom('198.51.100.8')).status).toBe(201);
    });

    it('without a trusted client IP there is no budget to key on, so nothing is refused', async () => {
      delete process.env.MCP_TRUST_PROXY_HEADERS;
      for (let i = 0; i < PUBLIC_BUDGETS.register.max + 3; i++) expect((await registerFrom('198.51.100.7')).status).toBe(201);
    });
  });

  describe('GET /oauth/authorize', () => {
    it('the request after the budget gets a 429 error PAGE (no redirect); another IP is unaffected', async () => {
      const limit = PUBLIC_BUDGETS.authorize.max;
      for (let i = 0; i < limit; i++) expect((await authorizeFrom(clientId, '198.51.100.7')).status).toBe(200);
      const over = await authorizeFrom(clientId, '198.51.100.7');
      expect(over.status).toBe(429);
      expect(over.headers.get('location')).toBeNull();
      expect(over.headers.get('content-type')).toContain('text/html');
      expect(over.headers.get('retry-after')).toBeTruthy();
      expect(await over.text()).toContain('Too many');
      expect((await authorizeFrom(clientId, '198.51.100.8')).status).toBe(200);
    });
  });
});
