import { rateLimiter, RATE_LIMITS } from '../src/middleware/rate-limit';
import { _resetSharedStoreForTests } from '../src/lib/shared-store';
import { NextRequest } from 'next/server';

const STORE_URL = 'https://example-redis.upstash.io';
const STORE_TOKEN = 'test-store-token';
const STORE_ENV = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN'];

function makeResponse(ok: boolean, status: number, body: unknown) {
  return { ok, status, text: async () => JSON.stringify(body) };
}

/** An Upstash pipeline reply: `[{ result: <INCR count> }, { result: <EXPIRE flag> }]`. */
function pipelineCount(count: number) {
  return makeResponse(true, 200, [{ result: count }, { result: 1 }]);
}

describe('Rate Limiter Middleware', () => {
  const originalEnv = process.env;
  let mockFetch: jest.Mock;

  beforeEach(() => {
    process.env = { ...originalEnv, MCP_RATE_LIMIT_TIER: 'internal' };
    for (const name of STORE_ENV) delete process.env[name];
    mockFetch = jest.fn();
    (global as unknown as { fetch: jest.Mock }).fetch = mockFetch;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    _resetSharedStoreForTests();
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  describe('in-memory (no shared store configured)', () => {
    it('should allow requests within limit', async () => {
      const req = new NextRequest('http://localhost/api/mcp');
      const result = await rateLimiter(req, `user-${Math.random()}`);
      expect(result.success).toBe(true);
      expect(result.remaining).toBe(RATE_LIMITS.internal.requestsPerMinute - 1);
    });

    it('should block requests once the tier limit is exhausted', async () => {
      process.env.MCP_RATE_LIMIT_TIER = 'public';
      const limit = RATE_LIMITS.public.requestsPerMinute;
      const req = new NextRequest('http://localhost/api/mcp');
      const userId = `user-exceed-${Math.random()}`;

      // Exhaust exactly the configured limit (derived, not hardcoded).
      for (let i = 0; i < limit; i++) {
        const r = await rateLimiter(req, userId);
        expect(r.success).toBe(true);
      }

      const result = await rateLimiter(req, userId);
      expect(result.success).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.error).toContain('Rate limit exceeded');
    });

    it('isolates counts per client id', async () => {
      process.env.MCP_RATE_LIMIT_TIER = 'public';
      const req = new NextRequest('http://localhost/api/mcp');
      for (let i = 0; i < RATE_LIMITS.public.requestsPerMinute; i++) {
        await rateLimiter(req, 'client-a');
      }
      // A different client is unaffected by client-a's exhaustion.
      const other = await rateLimiter(req, 'client-b');
      expect(other.success).toBe(true);
    });

    it('never touches the network', async () => {
      const req = new NextRequest('http://localhost/api/mcp');
      await rateLimiter(req, `user-${Math.random()}`);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('with a shared store (Upstash)', () => {
    const NOW = 1_700_000_000_000;
    const WINDOW_ID = Math.floor(NOW / 60_000);

    function pipelineBody(index = 0): unknown[][] {
      const init = mockFetch.mock.calls[index][1] as RequestInit;
      return JSON.parse(init.body as string) as unknown[][];
    }

    beforeEach(() => {
      process.env.MCP_RATE_LIMIT_TIER = 'public';
      process.env.UPSTASH_REDIS_REST_URL = STORE_URL;
      process.env.UPSTASH_REDIS_REST_TOKEN = STORE_TOKEN;
      jest.spyOn(Date, 'now').mockReturnValue(NOW);
    });

    it('counts in a fixed one-minute window keyed on the principal and returns the remaining budget', async () => {
      mockFetch.mockResolvedValue(pipelineCount(3));
      const req = new NextRequest('http://localhost/api/mcp');
      const userId = `user-${Math.random()}`;

      const result = await rateLimiter(req, userId);

      expect(result).toEqual({ success: true, remaining: RATE_LIMITS.public.requestsPerMinute - 3 });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${STORE_URL}/pipeline`);
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${STORE_TOKEN}`);
      // SPLIT-1449: keys carry the budget (`req` here, `tools` for tool calls).
      const key = `mcp:rl:req:user:${userId}:${WINDOW_ID}`;
      expect(pipelineBody()).toEqual([
        ['INCR', key],
        ['EXPIRE', key, 60, 'NX'],
      ]);
    });

    it('allows the request that lands exactly on the limit', async () => {
      mockFetch.mockResolvedValue(pipelineCount(RATE_LIMITS.public.requestsPerMinute));
      const result = await rateLimiter(new NextRequest('http://localhost/api/mcp'), 'user-at-limit');
      expect(result.success).toBe(true);
      expect(result.remaining).toBe(0);
    });

    it('blocks once the shared count exceeds the tier limit', async () => {
      mockFetch.mockResolvedValue(pipelineCount(RATE_LIMITS.public.requestsPerMinute + 1));
      const result = await rateLimiter(new NextRequest('http://localhost/api/mcp'), 'user-over-limit');
      expect(result.success).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.error).toContain(`Maximum ${RATE_LIMITS.public.requestsPerMinute} requests per minute`);
    });

    it('honours the tier table against the shared count', async () => {
      process.env.MCP_RATE_LIMIT_TIER = 'internal';
      mockFetch.mockResolvedValue(pipelineCount(RATE_LIMITS.public.requestsPerMinute + 1));
      const result = await rateLimiter(new NextRequest('http://localhost/api/mcp'), 'user-internal');
      expect(result.success).toBe(true);
      expect(result.remaining).toBe(RATE_LIMITS.internal.requestsPerMinute - RATE_LIMITS.public.requestsPerMinute - 1);
    });

    it('keys operator-key callers (no user) on their network address only when proxy headers are trusted', async () => {
      mockFetch.mockResolvedValue(pipelineCount(1));
      process.env.MCP_TRUST_PROXY_HEADERS = '1';
      const req = new NextRequest('http://localhost/api/mcp', { headers: { 'x-real-ip': '203.0.113.9' } });
      await rateLimiter(req);
      expect(pipelineBody()[0]).toEqual(['INCR', `mcp:rl:req:ip:203.0.113.9:${WINDOW_ID}`]);

      // Untrusted headers (no proxy in front): a spoofable x-real-ip must not mint a fresh bucket.
      delete process.env.MCP_TRUST_PROXY_HEADERS;
      mockFetch.mockClear();
      await rateLimiter(new NextRequest('http://localhost/api/mcp', { headers: { 'x-real-ip': '198.51.100.1' } }));
      expect(pipelineBody()[0]).toEqual(['INCR', `mcp:rl:req:operator:${WINDOW_ID}`]);
    });

    it('falls back to the in-memory limiter for the request when the store is unavailable', async () => {
      mockFetch.mockRejectedValue(new TypeError('fetch failed'));
      const req = new NextRequest('http://localhost/api/mcp');
      const userId = `user-fallback-${Math.random()}`;

      const first = await rateLimiter(req, userId);
      const second = await rateLimiter(req, userId);

      // Both attempts consulted the store, then counted locally.
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(first).toEqual({ success: true, remaining: RATE_LIMITS.public.requestsPerMinute - 1 });
      expect(second).toEqual({ success: true, remaining: RATE_LIMITS.public.requestsPerMinute - 2 });
    });

    it('falls back when the store answers with an error entry', async () => {
      mockFetch.mockResolvedValue(makeResponse(true, 200, [{ error: 'ERR max requests limit exceeded' }, { result: 0 }]));
      const result = await rateLimiter(new NextRequest('http://localhost/api/mcp'), `user-err-${Math.random()}`);
      expect(result).toEqual({ success: true, remaining: RATE_LIMITS.public.requestsPerMinute - 1 });
    });

    it('resumes using the store once it recovers', async () => {
      mockFetch
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(pipelineCount(RATE_LIMITS.public.requestsPerMinute + 5));
      const req = new NextRequest('http://localhost/api/mcp');
      const userId = `user-recover-${Math.random()}`;

      expect((await rateLimiter(req, userId)).success).toBe(true);
      expect((await rateLimiter(req, userId)).success).toBe(false);
    });
  });

  /**
   * The limiter used to key on the WHOLE raw `x-forwarded-for` header, which the
   * client writes. Rotating it minted a fresh bucket per request, so the limit
   * bound nobody. Only the last hop — the entry the trusted proxy appends —
   * may key the bucket.
   */
  describe('bucket key cannot be rotated by the caller', () => {
    const ipRequest = (headers: Record<string, string>) =>
      new NextRequest('http://localhost/api/mcp', { headers });

    // Proxy headers are only believed where a trusted proxy sets them (Vercel,
    // or this explicit opt-in); off-proxy every operator-key caller shares one
    // bucket, which the last case below exercises with the flag off.
    beforeEach(() => {
      process.env.MCP_TRUST_PROXY_HEADERS = '1';
    });

    it('ignores a rotating client-supplied prefix on x-forwarded-for', async () => {
      process.env.MCP_RATE_LIMIT_TIER = 'public';
      const limit = RATE_LIMITS.public.requestsPerMinute;

      for (let i = 0; i < limit; i++) {
        // A different forged prefix every time; the real (appended) hop is constant.
        const r = await rateLimiter(ipRequest({ 'x-forwarded-for': `10.0.0.${i}, 203.0.113.7` }));
        expect(r.success).toBe(true);
      }

      const blocked = await rateLimiter(ipRequest({ 'x-forwarded-for': '10.9.9.9, 203.0.113.7' }));
      expect(blocked.success).toBe(false);
      expect(blocked.remaining).toBe(0);
    });

    it('still separates genuinely different clients', async () => {
      process.env.MCP_RATE_LIMIT_TIER = 'public';
      for (let i = 0; i < RATE_LIMITS.public.requestsPerMinute; i++) {
        await rateLimiter(ipRequest({ 'x-forwarded-for': '198.51.100.1' }));
      }
      const other = await rateLimiter(ipRequest({ 'x-forwarded-for': '198.51.100.2' }));
      expect(other.success).toBe(true);
    });

    it('prefers the platform-set header over the client-supplied chain', async () => {
      process.env.MCP_RATE_LIMIT_TIER = 'public';
      const limit = RATE_LIMITS.public.requestsPerMinute;

      for (let i = 0; i < limit; i++) {
        const r = await rateLimiter(
          ipRequest({ 'x-vercel-forwarded-for': '192.0.2.55', 'x-forwarded-for': `10.0.0.${i}` }),
        );
        expect(r.success).toBe(true);
      }

      const blocked = await rateLimiter(
        ipRequest({ 'x-vercel-forwarded-for': '192.0.2.55', 'x-forwarded-for': '10.0.0.250' }),
      );
      expect(blocked.success).toBe(false);
    });

    it('falls back to x-real-ip when no forwarded chain is present', async () => {
      process.env.MCP_RATE_LIMIT_TIER = 'public';
      for (let i = 0; i < RATE_LIMITS.public.requestsPerMinute; i++) {
        const r = await rateLimiter(ipRequest({ 'x-real-ip': '203.0.113.44' }));
        expect(r.success).toBe(true);
      }
      const blocked = await rateLimiter(ipRequest({ 'x-real-ip': '203.0.113.44' }));
      expect(blocked.success).toBe(false);
    });

    it('namespaces the user and ip key spaces so one cannot exhaust the other', async () => {
      process.env.MCP_RATE_LIMIT_TIER = 'public';
      const collide = '192.0.2.99';
      for (let i = 0; i < RATE_LIMITS.public.requestsPerMinute; i++) {
        await rateLimiter(ipRequest({ 'x-forwarded-for': collide }));
      }
      // A user whose id is spelled like that IP gets their own budget.
      const user = await rateLimiter(ipRequest({ 'x-forwarded-for': collide }), collide);
      expect(user.success).toBe(true);
    });

    // Runs last: it exhausts the single shared fallback bucket.
    it('shares ONE bucket when the request carries no network identity at all', async () => {
      process.env.MCP_RATE_LIMIT_TIER = 'public';
      for (let i = 0; i < RATE_LIMITS.public.requestsPerMinute; i++) {
        const r = await rateLimiter(new NextRequest('http://localhost/api/mcp'));
        expect(r.success).toBe(true);
      }
      const blocked = await rateLimiter(new NextRequest('http://localhost/api/mcp'));
      expect(blocked.success).toBe(false);
      // ...and with proxy headers UNTRUSTED a spoofable address lands in that
      // same exhausted bucket instead of minting a fresh one.
      delete process.env.MCP_TRUST_PROXY_HEADERS;
      const spoofed = await rateLimiter(ipRequest({ 'x-forwarded-for': '198.51.100.77', 'x-real-ip': '198.51.100.78' }));
      expect(spoofed.success).toBe(false);
    });
  });
});
