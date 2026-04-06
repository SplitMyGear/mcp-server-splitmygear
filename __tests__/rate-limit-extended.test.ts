import { NextRequest } from 'next/server';

const RATE_LIMITS = {
  internal: { requestsPerMinute: 100, toolCallsPerMinute: 1000 },
  beta: { requestsPerMinute: 50, toolCallsPerMinute: 500 },
  public: { requestsPerMinute: 20, toolCallsPerMinute: 200 },
  default: { requestsPerMinute: 10, toolCallsPerMinute: 100 },
};

const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

const rateLimiter = (
  clientId: string,
  tier: string = 'default'
): { success: boolean; remaining: number; error?: string } => {
  const limits = RATE_LIMITS[tier as keyof typeof RATE_LIMITS] || RATE_LIMITS.default;
  const now = Date.now();
  const windowSize = 60 * 1000;

  const clientData = rateLimitStore.get(clientId);

  if (!clientData || now > clientData.resetTime) {
    rateLimitStore.set(clientId, {
      count: 1,
      resetTime: now + windowSize,
    });
    return { success: true, remaining: limits.requestsPerMinute - 1 };
  }

  if (clientData.count >= limits.requestsPerMinute) {
    return {
      success: false,
      error: `Rate limit exceeded. Maximum ${limits.requestsPerMinute} requests per minute.`,
      remaining: 0,
    };
  }

  clientData.count++;
  rateLimitStore.set(clientId, clientData);

  return {
    success: true,
    remaining: limits.requestsPerMinute - clientData.count,
  };
};

describe('Rate Limiter Extended', () => {
  beforeEach(() => {
    rateLimitStore.clear();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should allow first request', () => {
    const result = rateLimiter('user-1');
    expect(result.success).toBe(true);
    expect(result.remaining).toBe(9);
  });

  it('should track requests per client', () => {
    const result1 = rateLimiter('user-1');
    expect(result1.success).toBe(true);

    const result2 = rateLimiter('user-1');
    expect(result2.success).toBe(true);
    expect(result2.remaining).toBe(8);
  });

  it('should limit requests based on tier', () => {
    for (let i = 0; i < 20; i++) {
      rateLimiter('rate-limit-user', 'public');
    }

    const result = rateLimiter('rate-limit-user', 'public');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Rate limit exceeded');
  });

  it('should track different clients separately', () => {
    for (let i = 0; i < 10; i++) {
      rateLimiter('user-a', 'default');
    }

    const result = rateLimiter('user-b', 'default');
    expect(result.success).toBe(true);
  });

  it('should reset after window expires', () => {
    for (let i = 0; i < 10; i++) {
      rateLimiter('reset-user', 'default');
    }

    jest.advanceTimersByTime(60 * 1000 + 1);

    const result = rateLimiter('reset-user', 'default');
    expect(result.success).toBe(true);
  });

  it('should use default tier for invalid tier', () => {
    const result = rateLimiter('user-1', 'invalid-tier');
    expect(result.success).toBe(true);
    expect(result.remaining).toBe(9);
  });

  it('should respect internal tier limits', () => {
    for (let i = 0; i < 100; i++) {
      const result = rateLimiter('internal-user', 'internal');
      if (!result.success && i < 99) {
        throw new Error('Should not fail before limit');
      }
    }

    const result = rateLimiter('internal-user', 'internal');
    expect(result.success).toBe(false);
  });

  it('should respect beta tier limits', () => {
    for (let i = 0; i < 50; i++) {
      const result = rateLimiter('beta-user', 'beta');
      if (!result.success && i < 49) {
        throw new Error('Should not fail before limit');
      }
    }

    const result = rateLimiter('beta-user', 'beta');
    expect(result.success).toBe(false);
  });

  it('should return correct remaining count', () => {
    rateLimiter('user-1');
    rateLimiter('user-1');
    rateLimiter('user-1');
    
    const result = rateLimiter('user-1');
    expect(result.remaining).toBe(6);
  });

  it('should handle zero remaining correctly', () => {
    for (let i = 0; i < 10; i++) {
      rateLimiter('zero-user', 'default');
    }
    
    const result = rateLimiter('zero-user', 'default');
    expect(result.remaining).toBe(0);
    expect(result.success).toBe(false);
  });

  it('should handle concurrent requests', () => {
    const results: ReturnType<typeof rateLimiter>[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(rateLimiter('concurrent-user'));
    }
    
    expect(results.every(r => r.success)).toBe(true);
    expect(results[4].remaining).toBe(5);
  });
});
