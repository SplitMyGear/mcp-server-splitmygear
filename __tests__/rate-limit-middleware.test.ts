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
});
