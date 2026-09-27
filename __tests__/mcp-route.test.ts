/**
 * Route-handler test for /api/mcp (SPLIT-252 / M2).
 * The M2 bug: a module-singleton McpServer reused across requests was
 * "Already connected", so the per-request transport never initialized and
 * every call 400'd "Server not initialized". This proves a fresh stateless
 * server+transport per request now completes the initialize handshake.
 * Tool backends are mocked so no network/DB is touched.
 */
export {};

jest.mock('@/tools/listings', () => ({ listingTools: new Proxy({}, { get: () => jest.fn().mockResolvedValue([]) }) }));
jest.mock('@/tools/bookings', () => ({ bookingTools: new Proxy({}, { get: () => jest.fn().mockResolvedValue({}) }) }));
jest.mock('@/tools/pricing', () => ({ pricingTools: new Proxy({}, { get: () => jest.fn().mockResolvedValue({}) }) }));
jest.mock('@/tools/content', () => ({ contentTools: new Proxy({}, { get: () => jest.fn().mockResolvedValue({}) }) }));
jest.mock('@/tools/experiences', () => ({ experienceTools: new Proxy({}, { get: () => jest.fn().mockResolvedValue({}) }) }));
jest.mock('@/tools/messaging', () => ({ messagingTools: new Proxy({}, { get: () => jest.fn().mockResolvedValue({}) }) }));
// Both budgets are stubbed open here: this suite is about the transport, and
// the tool-call budget has its own suite (tool-call-rate-limit.test.ts) which
// exercises the REAL limiter through this same route.
jest.mock('@/middleware/rate-limit', () => ({
  rateLimiter: jest.fn().mockResolvedValue({ success: true }),
  toolCallRateLimiter: jest.fn().mockResolvedValue({ success: true }),
  countToolCalls: jest.fn().mockReturnValue(0),
}));

import { POST } from '../src/app/api/mcp/route';
import { ALL_TOOLS } from '../src/tools/defs';

function mcpRequest(body: unknown, withKey = true, extraHeaders: Record<string, string> = {}): any {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...extraHeaders,
  };
  if (withKey) headers['x-api-key'] = 'test-operator-key';
  const req = new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }) as any;
  req.nextUrl = { pathname: '/api/mcp' };
  return req;
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
};

describe('/api/mcp route handler (M2 stateless transport)', () => {
  beforeEach(() => { process.env.MCP_API_KEY = 'test-operator-key'; });
  afterEach(() => { delete process.env.MCP_API_KEY; });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await POST(mcpRequest(INIT, false));
    expect(res.status).toBe(401);
  });

  it('completes the initialize handshake (200 + serverInfo, no "Server not initialized")', async () => {
    const res = await POST(mcpRequest(INIT));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('splitmygear-mcp');
    expect(text).toContain('protocolVersion');
    expect(text).not.toContain('Server not initialized');
  });

  // SPLIT-1604: the first request of each claude.ai connection got a 400 on
  // prod and nothing said why. The SDK rejects an unsupported
  // MCP-Protocol-Version itself and reports it only through onerror.
  it('logs why the transport rejected a request (unsupported MCP-Protocol-Version), without the key or body', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await POST(
        mcpRequest({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, true, { 'mcp-protocol-version': '2099-01-01' }),
      );
      expect(res.status).toBe(400);
      const logged = warn.mock.calls.map((c) => String(c[0]));
      const line = logged.find((l) => l.startsWith('[mcp] transport rejected a request:'));
      expect(line).toContain('2099-01-01');
      expect(logged.join('\n')).not.toContain('test-operator-key');
      expect(logged.join('\n')).not.toContain('tools/list');
    } finally {
      warn.mockRestore();
    }
  });

  it('handles repeated requests independently (no "Already connected" leak)', async () => {
    const a = await POST(mcpRequest(INIT));
    const b = await POST(mcpRequest(INIT));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await b.text()).not.toContain('Already connected');
  });

  it('lists only read-scoped public tools for the operator key', async () => {
    const res = await POST(mcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
    expect(res.status).toBe(200);
    const names: string[] = (await res.json()).result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('search_listings');
    expect(names).not.toContain('get_my_profile');
    expect(names).not.toContain('get_personalized_recommendations'); // read scope, but needs a signed-in user
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      const def = ALL_TOOLS.find((t) => t.name === n)!;
      expect(def.access).toBe('public');
      expect(def.scope).toBe('read');
    }
  });
});
