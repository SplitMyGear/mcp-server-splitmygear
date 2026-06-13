export {};

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    auth: {
      getUser: jest.fn(),
    },
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          single: jest.fn(),
        })),
      })),
    })),
  })),
}));

import { authMiddleware } from '../src/middleware/auth';

// Build a backend-style JWT (HS256, claims = { sub, role, exp }). No signature
// verification happens unless MCP_BACKEND_JWT_SECRET is set, so the signature
// segment is a placeholder for these decode-path tests.
function makeJwt(payload: Record<string, unknown>): string {
  const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg(payload)}.sig`;
}
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

describe('Auth Middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.MCP_API_KEY = 'test-operator-key';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
  });

  afterEach(() => {
    delete process.env.MCP_API_KEY;
  });

  it('fails CLOSED when MCP_API_KEY is not configured (no public tier)', async () => {
    delete process.env.MCP_API_KEY;
    const mockRequest = {
      headers: new Headers({}),
      nextUrl: { pathname: '/api/mcp' },
    } as any;
    const result = await authMiddleware(mockRequest);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Server auth not configured');
  });

  it('accepts the operator API key as admin', async () => {
    const mockRequest = {
      headers: new Headers({ 'x-api-key': 'test-operator-key' }),
      nextUrl: { pathname: '/api/mcp' },
    } as any;
    const result = await authMiddleware(mockRequest);
    expect(result.success).toBe(true);
    expect(result.role).toBe('admin');
  });

  it('DENIES unauthenticated requests to /api/mcp (lockdown: no public tier)', async () => {
    const mockRequest = {
      headers: new Headers({}),
      nextUrl: { pathname: '/api/mcp' },
    } as any;

    const result = await authMiddleware(mockRequest);

    expect(result.success).toBe(false);
    expect(result.error).toBe('No authentication provided');
  });

  it('should reject requests without authentication for non-public endpoints', async () => {
    const mockRequest = {
      headers: new Headers({}),
      nextUrl: { pathname: '/api/admin' },
    } as any;
    
    const result = await authMiddleware(mockRequest);
    
    expect(result.success).toBe(false);
    expect(result.error).toBe('No authentication provided');
  });

  it('accepts a backend JWT, derives the user from sub, and exposes the token for forwarding', async () => {
    const token = makeJwt({ sub: 'user-123', role: 'vendor', exp: FUTURE });
    const mockRequest = {
      headers: new Headers({ authorization: `Bearer ${token}` }),
      nextUrl: { pathname: '/api/mcp' },
    } as any;

    const result = await authMiddleware(mockRequest);

    expect(result.success).toBe(true);
    expect(result.userId).toBe('user-123');
    expect(result.role).toBe('vendor');
    // The raw token must be surfaced so user-scoped tools can forward it.
    expect(result.token).toBe(token);
  });

  it('rejects a malformed bearer token (not a JWT)', async () => {
    const mockRequest = {
      headers: new Headers({ authorization: 'Bearer not-a-jwt' }),
      nextUrl: { pathname: '/api/mcp' },
    } as any;

    const result = await authMiddleware(mockRequest);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid token');
  });

  it('rejects an expired backend JWT', async () => {
    const token = makeJwt({ sub: 'user-123', role: 'renter', exp: Math.floor(Date.now() / 1000) - 60 });
    const mockRequest = {
      headers: new Headers({ authorization: `Bearer ${token}` }),
      nextUrl: { pathname: '/api/mcp' },
    } as any;

    const result = await authMiddleware(mockRequest);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid token');
  });

  it('should accept valid API key', async () => {
    const { createClient } = require('@supabase/supabase-js');
    const mockSupabase = {
      from: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            single: jest.fn().mockResolvedValue({
              data: { user_id: 'user-456', role: 'vendor' },
              error: null,
            }),
          }),
        }),
      }),
    };
    (createClient as jest.Mock).mockReturnValue(mockSupabase);

    const mockRequest = {
      headers: new Headers({ 'x-api-key': 'valid-api-key' }),
      nextUrl: { pathname: '/api/mcp' },
    } as any;
    
    const result = await authMiddleware(mockRequest);
    
    expect(result.success).toBe(true);
    expect(result.userId).toBe('user-456');
    expect(result.role).toBe('vendor');
  });

  it('should reject invalid API key', async () => {
    const { createClient } = require('@supabase/supabase-js');
    const mockSupabase = {
      from: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            single: jest.fn().mockResolvedValue({
              data: null,
              error: { message: 'Not found' },
            }),
          }),
        }),
      }),
    };
    (createClient as jest.Mock).mockReturnValue(mockSupabase);

    const mockRequest = {
      headers: new Headers({ 'x-api-key': 'invalid-api-key' }),
      nextUrl: { pathname: '/api/mcp' },
    } as any;
    
    const result = await authMiddleware(mockRequest);
    
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid API key');
  });
});
