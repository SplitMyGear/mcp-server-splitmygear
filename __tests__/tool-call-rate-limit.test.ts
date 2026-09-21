/**
 * SPLIT-1449: `toolCallsPerMinute` is enforced against real tool invocations.
 *
 * Before this, the constant was declared in RATE_LIMITS and consumed nowhere,
 * and the only live limiter counted HTTP requests. Since one JSON-RPC POST may
 * carry a BATCH and the transport dispatches every member, N tool calls cost
 * exactly 1 unit of the only budget that existed — so the advertised ceiling
 * bounded HTTP traffic, not the backend work behind it.
 *
 * The route-level cases below run the REAL limiter against the REAL transport
 * (only the tool backends are mocked), so they fail if the charge is not
 * applied where it has to be: before dispatch.
 */
export {};

jest.mock('@/tools/listings', () => ({ listingTools: new Proxy({}, { get: () => jest.fn().mockResolvedValue([]) }) }));
jest.mock('@/tools/bookings', () => ({ bookingTools: new Proxy({}, { get: () => jest.fn().mockResolvedValue({}) }) }));
jest.mock('@/tools/pricing', () => ({ pricingTools: new Proxy({}, { get: () => jest.fn().mockResolvedValue({}) }) }));
jest.mock('@/tools/content', () => ({ contentTools: new Proxy({}, { get: () => jest.fn().mockResolvedValue({}) }) }));
jest.mock('@/tools/experiences', () => ({ experienceTools: new Proxy({}, { get: () => jest.fn().mockResolvedValue({}) }) }));
jest.mock('@/tools/messaging', () => ({ messagingTools: new Proxy({}, { get: () => jest.fn().mockResolvedValue({}) }) }));

import { NextRequest } from 'next/server';
import { RATE_LIMITS, countToolCalls, toolCallRateLimiter } from '../src/middleware/rate-limit';
import { _resetSharedStoreForTests } from '../src/lib/shared-store';
import { POST } from '../src/app/api/mcp/route';

// Buckets are keyed per source address only where proxy headers are trusted
// (Vercel, or this explicit opt-in); the cases below attribute each request
// to its own IP, so the flag is on throughout.
const TRUST_PROXY = { MCP_TRUST_PROXY_HEADERS: '1' } as const;

const TIER = 'default';
const TOOL_CALL_LIMIT = RATE_LIMITS.default.toolCallsPerMinute; // 100
const REQUEST_LIMIT = RATE_LIMITS.default.requestsPerMinute; //  10

const toolCall = (id: number) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: 'search_listings', arguments: {} },
});

const batch = (size: number, offset = 0) =>
  Array.from({ length: size }, (_, i) => toolCall(offset + i + 1));

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
};

/** A POST carrying `body`, attributed to `ip` so each test gets its own bucket. */
function mcpRequest(body: unknown, ip: string, raw?: string): NextRequest {
  const req = new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-api-key': 'test-operator-key',
      'x-forwarded-for': ip,
    },
    body: raw ?? JSON.stringify(body),
  }) as NextRequest;
  // The route only reads `.method`, `.headers` and `.json()`; `nextUrl` is set
  // because NextRequest consumers elsewhere expect it to exist.
  Object.defineProperty(req, 'nextUrl', { value: { pathname: '/api/mcp' } });
  return req;
}

const errorOf = async (res: Response): Promise<string> => {
  const body: unknown = JSON.parse(await res.text());
  return typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : '';
};

describe('countToolCalls', () => {
  it('counts a single tools/call message as one', () => {
    expect(countToolCalls(toolCall(1))).toBe(1);
  });

  it('counts EVERY member of a batch, not the request', () => {
    expect(countToolCalls(batch(7))).toBe(7);
  });

  it('prices only tools/call inside a mixed batch', () => {
    expect(countToolCalls([INIT, toolCall(2), { jsonrpc: '2.0', id: 3, method: 'tools/list' }, toolCall(4)])).toBe(2);
  });

  it('charges nothing for non-tool traffic', () => {
    expect(countToolCalls(INIT)).toBe(0);
    expect(countToolCalls({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toBe(0);
    expect(countToolCalls([])).toBe(0);
  });

  it('never throws on payloads the transport has not validated yet', () => {
    expect(countToolCalls(null)).toBe(0);
    expect(countToolCalls(undefined)).toBe(0);
    expect(countToolCalls('tools/call')).toBe(0);
    expect(countToolCalls(42)).toBe(0);
    expect(countToolCalls([null, 'x', 7, toolCall(1)])).toBe(1);
  });
});

describe('toolCallRateLimiter', () => {
  const originalEnv = process.env;
  const ipRequest = (ip: string) =>
    new NextRequest('http://localhost/api/mcp', { headers: { 'x-forwarded-for': ip } });

  beforeEach(() => {
    process.env = { ...originalEnv, MCP_RATE_LIMIT_TIER: TIER, ...TRUST_PROXY };
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('charges the budget per tool call, not per request', async () => {
    const req = ipRequest('203.0.113.1');
    const first = await toolCallRateLimiter(req, 10);
    expect(first.success).toBe(true);
    expect(first.remaining).toBe(TOOL_CALL_LIMIT - 10);

    const second = await toolCallRateLimiter(req, 30);
    expect(second.success).toBe(true);
    expect(second.remaining).toBe(TOOL_CALL_LIMIT - 40);
  });

  it('blocks the call that would cross the ceiling', async () => {
    const req = ipRequest('203.0.113.2');
    expect((await toolCallRateLimiter(req, TOOL_CALL_LIMIT)).success).toBe(true);

    const blocked = await toolCallRateLimiter(req, 1);
    expect(blocked.success).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.error).toContain('tool calls per minute');
  });

  it('refuses an oversized batch WITHOUT consuming budget', async () => {
    const req = ipRequest('203.0.113.3');
    await toolCallRateLimiter(req, TOOL_CALL_LIMIT - 10);

    const refused = await toolCallRateLimiter(req, 50);
    expect(refused.success).toBe(false);
    expect(refused.remaining).toBe(10);

    // The refusal cost nothing, so the remaining 10 are still spendable.
    const after = await toolCallRateLimiter(req, 10);
    expect(after.success).toBe(true);
    expect(after.remaining).toBe(0);
  });

  it('refuses a batch larger than the whole allowance even on a fresh window', async () => {
    const refused = await toolCallRateLimiter(ipRequest('203.0.113.4'), TOOL_CALL_LIMIT + 1);
    expect(refused.success).toBe(false);
  });

  it('is free for requests carrying no tool calls', async () => {
    const req = ipRequest('203.0.113.5');
    expect((await toolCallRateLimiter(req, 0)).success).toBe(true);
    // Zero touched no state, so the full allowance is still there.
    expect((await toolCallRateLimiter(req, TOOL_CALL_LIMIT)).success).toBe(true);
  });

  it('keeps a budget per client, keyed like the request limiter', async () => {
    await toolCallRateLimiter(ipRequest('203.0.113.6'), TOOL_CALL_LIMIT);
    expect((await toolCallRateLimiter(ipRequest('203.0.113.7'), 1)).success).toBe(true);
  });

  it('cannot be reset by rotating a client-supplied x-forwarded-for prefix', async () => {
    // Same trusted last hop, a forged prefix every time: one bucket, not many.
    for (let i = 0; i < 4; i++) {
      const r = await toolCallRateLimiter(ipRequest(`10.0.0.${i}, 203.0.113.8`), 25);
      expect(r.success).toBe(true);
    }
    const blocked = await toolCallRateLimiter(ipRequest('10.9.9.9, 203.0.113.8'), 1);
    expect(blocked.success).toBe(false);
  });
});

describe('/api/mcp enforces the tool-call budget before dispatch', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, MCP_RATE_LIMIT_TIER: TIER, MCP_API_KEY: 'test-operator-key', ...TRUST_PROXY };
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('still dispatches a tool call, so the pre-read body reaches the transport', async () => {
    const res = await POST(mcpRequest(toolCall(1), '198.51.100.1'));
    expect(res.status).toBe(200);
    // A result (not "Parse error"/"Invalid request") proves the transport got
    // the body the route already consumed, via HandleRequestOptions.parsedBody.
    const text = await res.text();
    expect(text).toContain('"result"');
    expect(text).not.toContain('-32700');
  });

  it('charges a batch per member: one POST can no longer buy N invocations', async () => {
    const ip = '198.51.100.2';
    const half = TOOL_CALL_LIMIT / 2 + 10; // 60

    const first = await POST(mcpRequest(batch(half), ip));
    expect(first.status).not.toBe(429);

    // 60 + 60 > 100 — refused, although only the SECOND of 10 permitted
    // requests per minute has been spent. Under the old limiter both POSTs
    // cost 1 unit each and all 120 invocations ran.
    const second = await POST(mcpRequest(batch(half, 1000), ip));
    expect(second.status).toBe(429);
    expect(await errorOf(second)).toContain('tool calls per minute');

    // The refusal consumed nothing, so the untouched 40 are still spendable.
    const third = await POST(mcpRequest(batch(TOOL_CALL_LIMIT - half, 2000), ip));
    expect(third.status).not.toBe(429);
  });

  it('refuses a single batch that exceeds the entire per-minute allowance', async () => {
    const oversized = TOOL_CALL_LIMIT + 1; // 101 invocations in ONE request
    const res = await POST(mcpRequest(batch(oversized), '198.51.100.3'));

    expect(res.status).toBe(429);
    expect(await errorOf(res)).toContain(`asked for ${oversized}`);
  });

  it('leaves non-tool traffic uncharged', async () => {
    const ip = '198.51.100.4';
    for (let i = 0; i < REQUEST_LIMIT - 1; i++) {
      const res = await POST(mcpRequest(INIT, ip));
      expect(res.status).toBe(200);
    }
    // Nine initializes spent nine of ten requests but zero tool calls, so the
    // whole tool allowance is still available.
    const res = await POST(mcpRequest(batch(TOOL_CALL_LIMIT), ip));
    expect(res.status).not.toBe(429);
  });

  it('leaves the transport to answer a malformed body with its own parse error', async () => {
    const res = await POST(mcpRequest(undefined, '198.51.100.5', 'this is not json'));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('-32700');
  });
});

/**
 * The same accounting over the SHARED store: a batch is one INCRBY of its
 * size, and a refused batch is handed back (DECRBY) so it cannot drain the
 * window it was refused from — all-or-nothing survives the distributed layer.
 */
describe('toolCallRateLimiter over a shared store (Upstash)', () => {
  const originalEnv = process.env;
  const STORE_URL = 'https://example-redis.upstash.io';
  const NOW = 1_700_000_000_000;
  const WINDOW_ID = Math.floor(NOW / 60_000);
  let mockFetch: jest.Mock;

  const reply = (count: number) => ({ ok: true, status: 200, text: async () => JSON.stringify([{ result: count }, { result: 1 }]) });
  const pipelineBody = (index: number): unknown[][] => JSON.parse((mockFetch.mock.calls[index][1] as RequestInit).body as string);
  const ipRequest = (ip: string) => new NextRequest('http://localhost/api/mcp', { headers: { 'x-forwarded-for': ip } });

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      MCP_RATE_LIMIT_TIER: TIER,
      ...TRUST_PROXY,
      UPSTASH_REDIS_REST_URL: STORE_URL,
      UPSTASH_REDIS_REST_TOKEN: 'test-store-token',
    };
    mockFetch = jest.fn();
    (global as unknown as { fetch: jest.Mock }).fetch = mockFetch;
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    _resetSharedStoreForTests();
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('charges a batch as ONE INCRBY of its size, in the tool-call key space', async () => {
    mockFetch.mockResolvedValue(reply(3 + 25));
    const result = await toolCallRateLimiter(ipRequest('203.0.113.50'), 25);

    expect(result).toEqual({ success: true, remaining: TOOL_CALL_LIMIT - 28 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const key = `mcp:rl:tools:ip:203.0.113.50:${WINDOW_ID}`;
    expect(pipelineBody(0)).toEqual([
      ['INCRBY', key, 25],
      ['EXPIRE', key, 60, 'NX'],
    ]);
  });

  it('refuses an over-limit batch AND hands the charge back, so the untouched remainder is still spendable', async () => {
    // 90 already spent this window; a batch of 25 would land at 115 > 100.
    mockFetch.mockResolvedValueOnce(reply(90 + 25)).mockResolvedValueOnce(reply(90));
    const refused = await toolCallRateLimiter(ipRequest('203.0.113.51'), 25);

    expect(refused.success).toBe(false);
    expect(refused.remaining).toBe(10);
    expect(refused.error).toContain('asked for 25');
    const key = `mcp:rl:tools:ip:203.0.113.51:${WINDOW_ID}`;
    expect(pipelineBody(0)[0]).toEqual(['INCRBY', key, 25]);
    expect(pipelineBody(1)[0]).toEqual(['DECRBY', key, 25]);
  });

  it('keeps the request budget in its own key space (plain INCR, req prefix)', async () => {
    mockFetch.mockResolvedValue(reply(1));
    const { rateLimiter } = await import('../src/middleware/rate-limit');
    await rateLimiter(ipRequest('203.0.113.52'));
    expect(pipelineBody(0)[0]).toEqual(['INCR', `mcp:rl:req:ip:203.0.113.52:${WINDOW_ID}`]);
  });

  it('falls back to the in-memory bucket for the request when the store is unavailable', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));
    const first = await toolCallRateLimiter(ipRequest('203.0.113.53'), 40);
    const second = await toolCallRateLimiter(ipRequest('203.0.113.53'), 70);
    expect(first).toEqual({ success: true, remaining: TOOL_CALL_LIMIT - 40 });
    expect(second.success).toBe(false); // 40 + 70 > 100, counted locally
  });
});
