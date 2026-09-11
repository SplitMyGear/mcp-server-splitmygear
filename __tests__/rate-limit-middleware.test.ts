import { rateLimiter, RATE_LIMITS } from '../src/middleware/rate-limit';
import { NextRequest } from 'next/server';

describe('Rate Limiter Middleware', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv, MCP_RATE_LIMIT_TIER: 'internal' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should allow requests within limit', async () => {
    const req = new NextRequest('http://localhost/api/mcp');
    const result = await rateLimiter(req, `user-${Math.random()}`);
    expect(result.success).toBe(true);
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

  /**
   * The limiter used to key on the WHOLE raw `x-forwarded-for` header, which the
   * client writes. Rotating it minted a fresh bucket per request, so the limit
   * bound nobody. Only the last hop — the entry the trusted proxy appends —
   * may key the bucket.
   */
  describe('bucket key cannot be rotated by the caller', () => {
    const ipRequest = (headers: Record<string, string>) =>
      new NextRequest('http://localhost/api/mcp', { headers });

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
    });
  });
});
