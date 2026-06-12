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
jest.mock('@/middleware/rate-limit', () => ({ rateLimiter: jest.fn().mockResolvedValue({ success: true }) }));

import { POST } from '../src/app/api/mcp/route';

function mcpRequest(body: unknown, withKey = true): any {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
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

  it('handles repeated requests independently (no "Already connected" leak)', async () => {
    const a = await POST(mcpRequest(INIT));
    const b = await POST(mcpRequest(INIT));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await b.text()).not.toContain('Already connected');
  });
});
