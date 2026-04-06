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

describe('Auth Middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return public role for public endpoint without auth', async () => {
    const mockRequest = {
      headers: new Headers({}),
      nextUrl: { pathname: '/api/mcp' },
    } as any;
    
    const result = await authMiddleware(mockRequest);
    
    expect(result.success).toBe(true);
    expect(result.role).toBe('public');
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

  it('should accept valid JWT token', async () => {
    const { createClient } = require('@supabase/supabase-js');
    const mockSupabase = {
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: { user: { id: 'user-123' } },
          error: null,
        }),
      },
      from: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            single: jest.fn().mockResolvedValue({
              data: { role: 'renter' },
              error: null,
            }),
          }),
        }),
      }),
    };
    (createClient as jest.Mock).mockReturnValue(mockSupabase);

    const mockRequest = {
      headers: new Headers({ 'authorization': 'Bearer valid-token' }),
      nextUrl: { pathname: '/api/mcp' },
    } as any;
    
    const result = await authMiddleware(mockRequest);
    
    expect(result.success).toBe(true);
    expect(result.userId).toBe('user-123');
  });

  it('should reject invalid JWT token', async () => {
    const { createClient } = require('@supabase/supabase-js');
    const mockSupabase = {
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: { user: null },
          error: { message: 'Invalid token' },
        }),
      },
    };
    (createClient as jest.Mock).mockReturnValue(mockSupabase);

    const mockRequest = {
      headers: new Headers({ 'authorization': 'Bearer invalid-token' }),
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
