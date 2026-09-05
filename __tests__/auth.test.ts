export {};

import { authMiddleware } from '../src/middleware/auth';
import { TOOL_SCOPES } from '../src/tools/registry';

import crypto from 'crypto';

// Build a backend-style JWT (HS256, claims = { sub, role, exp }). Raw bearer
// JWTs are only accepted when they verify against MCP_BACKEND_JWT_SECRET, so
// the tests sign with that secret; an unsigned placeholder must be rejected.
const JWT_SECRET = 'backend-jwt-secret-for-tests';
function makeJwt(payload: Record<string, unknown>, secret: string | null = JWT_SECRET): string {
  const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const signingInput = `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg(payload)}`;
  const sig = secret ? crypto.createHmac('sha256', secret).update(signingInput).digest('base64url') : 'sig';
  return `${signingInput}.${sig}`;
}
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

describe('Auth Middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.MCP_API_KEY = 'test-operator-key';
    process.env.MCP_BACKEND_JWT_SECRET = JWT_SECRET;
  });

  afterEach(() => {
    delete process.env.MCP_API_KEY;
    delete process.env.MCP_BACKEND_JWT_SECRET;
  });

  it('fails CLOSED when nothing is configured (no public tier)', async () => {
    delete process.env.MCP_API_KEY;
    delete process.env.MCP_BACKEND_JWT_SECRET;
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
    // The operator key is a server-to-server credential: public discovery only.
    expect(result.kind).toBe('operator');
    expect(result.scopes).toEqual(['read']);
  });

  it('rejects a wrong operator API key (constant-time compare, SPLIT-335)', async () => {
    const mockRequest = {
      headers: new Headers({ 'x-api-key': 'wrong-key' }),
      nextUrl: { pathname: '/api/mcp' },
    } as any;
    const result = await authMiddleware(mockRequest);
    expect(result.success).toBe(false);
    expect(result.error).toBe('No authentication provided');
  });

  it('rejects an operator API key that is a prefix of the real key (SPLIT-335)', async () => {
    const mockRequest = {
      headers: new Headers({ 'x-api-key': 'test-operator' }),
      nextUrl: { pathname: '/api/mcp' },
    } as any;
    const result = await authMiddleware(mockRequest);
    expect(result.success).toBe(false);
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
    // A verified first-party session is not scope-limited: every scope, role gates still apply.
    expect(result.kind).toBe('jwt');
    expect(result.scopes).toEqual([...TOOL_SCOPES]);
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

  it('REJECTS an unsigned / unverifiable raw JWT (an unverified JWT is just a string anyone can type)', async () => {
    const forged = makeJwt({ sub: 'attacker', role: 'admin', exp: FUTURE }, null);
    const withSecret = await authMiddleware({ headers: new Headers({ authorization: `Bearer ${forged}` }), nextUrl: { pathname: '/api/mcp' } } as any);
    expect(withSecret).toMatchObject({ success: false, invalidCredentials: true });
    // And the whole raw-JWT path is closed when no verification secret is configured.
    delete process.env.MCP_BACKEND_JWT_SECRET;
    const genuineLooking = makeJwt({ sub: 'u1', role: 'renter', exp: FUTURE }, 'some-other-secret');
    const noSecret = await authMiddleware({ headers: new Headers({ authorization: `Bearer ${genuineLooking}` }), nextUrl: { pathname: '/api/mcp' } } as any);
    expect(noSecret.success).toBe(false);
    expect(noSecret.error).toMatch(/sign in via OAuth/);
  });

  it('rejects a non-operator x-api-key with no bearer (api_keys path removed — no Supabase)', async () => {
    const mockRequest = {
      headers: new Headers({ 'x-api-key': 'some-other-key' }),
      nextUrl: { pathname: '/api/mcp' },
    } as any;

    const result = await authMiddleware(mockRequest);

    expect(result.success).toBe(false);
    expect(result.error).toBe('No authentication provided');
  });
});

describe('Auth Middleware: OAuth access envelopes', () => {
  const KEY = 'unit-test-signing-key-with-at-least-32-bytes!!';
  beforeEach(() => { process.env.MCP_API_KEY = 'test-operator-key'; process.env.MCP_OAUTH_SIGNING_KEY = KEY; });
  afterEach(() => { delete process.env.MCP_API_KEY; delete process.env.MCP_OAUTH_SIGNING_KEY; });

  it('accepts an MCP-issued access token and forwards the wrapped backend JWT', async () => {
    const { issueTokens } = await import('../src/lib/oauth/tokens');
    const backend = makeJwt({ sub: 'user-9', role: 'vendor_owner', email: 'v@x.test', exp: FUTURE });
    const tokens = issueTokens({ clientId: 'c1', user: { id: 'user-9', role: 'vendor_owner', email: 'v@x.test' }, backendAccessToken: backend, backendRefreshToken: 'brt', scopes: ['finance', 'read'] })!;
    const result = await authMiddleware({ headers: new Headers({ authorization: `Bearer ${tokens.access_token}` }), nextUrl: { pathname: '/api/mcp' } } as any);
    expect(result).toMatchObject({ success: true, userId: 'user-9', role: 'vendor_owner', email: 'v@x.test', token: backend, kind: 'oauth' });
    // The granted scopes ride along (canonical order) so the registry can filter tools/list.
    expect(result.scopes).toEqual(['read', 'finance']);
  });

  it('carries an empty scope set through unchanged (a token that may use no tools)', async () => {
    const { issueTokens } = await import('../src/lib/oauth/tokens');
    const backend = makeJwt({ sub: 'user-9', role: 'renter', email: 'v@x.test', exp: FUTURE });
    const tokens = issueTokens({ clientId: 'c1', user: { id: 'user-9', role: 'renter', email: 'v@x.test' }, backendAccessToken: backend, backendRefreshToken: 'brt', scopes: [] })!;
    expect(tokens.scope).toBe('');
    const result = await authMiddleware({ headers: new Headers({ authorization: `Bearer ${tokens.access_token}` }), nextUrl: { pathname: '/api/mcp' } } as any);
    expect(result.success).toBe(true);
    expect(result.scopes).toEqual([]);
  });

  it('rejects a tampered/foreign envelope and flags it as invalid credentials', async () => {
    const result = await authMiddleware({ headers: new Headers({ authorization: 'Bearer smg_at.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }), nextUrl: { pathname: '/api/mcp' } } as any);
    expect(result).toMatchObject({ success: false, invalidCredentials: true });
  });

  it('refuses to wrap a backend JWT it cannot read, and rejects an envelope whose inner JWT expired', async () => {
    const { issueTokens, openAccessToken } = await import('../src/lib/oauth/tokens');
    expect(issueTokens({ clientId: 'c1', user: { id: 'u', role: 'renter', email: 'e' }, backendAccessToken: 'not-a-jwt', backendRefreshToken: 'r', scopes: ['read'] })).toBeNull();
    const expiredInner = makeJwt({ sub: 'u', role: 'renter', exp: Math.floor(Date.now() / 1000) + 1 });
    const tokens = issueTokens({ clientId: 'c1', user: { id: 'u', role: 'renter', email: 'e' }, backendAccessToken: expiredInner, backendRefreshToken: 'r', scopes: ['read'] })!;
    await new Promise((r) => setTimeout(r, 1100));
    expect(openAccessToken(tokens.access_token)).toBeNull();
  });
});
