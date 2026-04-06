import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

const RATE_LIMITS = {
  internal: { requestsPerMinute: 100, toolCallsPerMinute: 1000 },
  beta: { requestsPerMinute: 50, toolCallsPerMinute: 500 },
  public: { requestsPerMinute: 20, toolCallsPerMinute: 200 },
  default: { requestsPerMinute: 10, toolCallsPerMinute: 100 },
};

export interface RateLimitResult {
  success: boolean;
  error?: string;
  remaining?: number;
}

export async function rateLimiter(
  request: NextRequest,
  userId?: string
): Promise<RateLimitResult> {
  const clientId = userId || (request as any).ip || request.headers.get('x-forwarded-for') || 'anonymous';
  
  const tier = process.env.MCP_RATE_LIMIT_TIER || 'default';
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
}

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of rateLimitStore.entries()) {
    if (now > value.resetTime) {
      rateLimitStore.delete(key);
    }
  }
}, 60 * 1000);
