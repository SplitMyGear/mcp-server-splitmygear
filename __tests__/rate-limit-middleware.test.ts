import { rateLimiter } from '../src/middleware/rate-limit';
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

  it('should block requests exceeding limit', async () => {
    process.env.MCP_RATE_LIMIT_TIER = 'public'; // Low limit (10/min)
    const req = new NextRequest('http://localhost/api/mcp');
    const userId = `user-exceed-${Math.random()}`;
    
    // Exhaust limit
    for (let i = 0; i < 10; i++) {
      await rateLimiter(req, userId);
    }
    
    const result = await rateLimiter(req, userId);
    expect(result.success).toBe(false);
  });
});
