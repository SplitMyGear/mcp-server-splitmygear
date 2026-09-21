export {};

import crypto from 'crypto';
import { authMiddleware } from '../src/middleware/auth';
import { TOOL_SCOPES } from '../src/tools/registry';

// Build a backend-style JWT (HS256, claims = { sub, role, exp }). `secret`
// null ⇒ a junk signature, i.e. the forgery an attacker can mint: a header,
// any claims they like, and whatever trailing segment they please. A raw
// bearer is VERIFIED before it authenticates (SPLIT-1438): in-process against
// MCP_BACKEND_JWT_SECRET when it is set, otherwise against the backend.
const JWT_SECRET = 'backend-jwt-secret-for-tests';
function makeJwt(payload: Record<string, unknown>, secret: string | null = JWT_SECRET): string {
  const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const signingInput = `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg(payload)}`;
  const sig = secret ? crypto.createHmac('sha256', secret).update(signingInput).digest('base64url') : 'sig';
  return `${signingInput}.${sig}`;
}
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

function bearerRequest(token: string): any {
  return {
    headers: new Headers({ authorization: `Bearer ${token}` }),
    nextUrl: { pathname: '/api/mcp' },
  };
}

describe('Auth Middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.MCP_API_KEY = 'test-operator-key';
    // Exercise the local verification path by default; the backend-verified
    // path (the deployed configuration) has its own block below.
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

  it('accepts a VERIFIED backend JWT, derives the user from sub, and exposes the token for forwarding', async () => {
    const token = makeJwt({ sub: 'user-123', role: 'vendor', exp: FUTURE });

    const result = await authMiddleware(bearerRequest(token));

    expect(result.success).toBe(true);
    expect(result.userId).toBe('user-123');
    expect(result.role).toBe('vendor');
    // The raw token must be surfaced so user-scoped tools can forward it.
    expect(result.token).toBe(token);
    // A verified first-party session is not scope-limited: every scope, role gates still apply.
    expect(result.kind).toBe('jwt');
    expect(result.scopes).toEqual([...TOOL_SCOPES]);
  });

  /**
   * THE REGRESSION RAIL (SPLIT-1438). This case previously asserted the
   * opposite — a token with the literal signature `'sig'` was accepted as
   * `user-123`/`vendor`, encoding the vulnerability into the suite. A forged
   * bearer must be denied on every path, including the no-secret deployment
   * covered below.
   */
  it('REJECTS a forged bearer token (valid shape, junk signature)', async () => {
    const forged = makeJwt({ sub: 'user-123', role: 'admin', exp: FUTURE }, null);

    const result = await authMiddleware(bearerRequest(forged));

    expect(result).toMatchObject({ success: false, error: 'Invalid token', invalidCredentials: true });
    expect(result.userId).toBeUndefined();
    expect(result.role).toBeUndefined();
    expect(result.token).toBeUndefined();
    expect(result.scopes).toBeUndefined();
  });

  it('REJECTS a bearer token signed with the wrong key', async () => {
    const forged = makeJwt({ sub: 'attacker', role: 'admin', exp: FUTURE }, 'not-the-backend-secret');

    const result = await authMiddleware(bearerRequest(forged));

    expect(result).toMatchObject({ success: false, error: 'Invalid token', invalidCredentials: true });
  });

  it('rejects a malformed bearer token (not a JWT)', async () => {
    const result = await authMiddleware(bearerRequest('not-a-jwt'));

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid token');
    expect(result.invalidCredentials).toBe(true);
  });

  it('rejects an expired backend JWT even when correctly signed', async () => {
    const token = makeJwt({ sub: 'user-123', role: 'renter', exp: Math.floor(Date.now() / 1000) - 60 });

    const result = await authMiddleware(bearerRequest(token));

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid token');
  });

  /**
   * The PRODUCTION configuration: `MCP_BACKEND_JWT_SECRET` is not set on the
   * Vercel project, so identity is resolved against the backend itself. The
   * forged-token case here is the one that was live. (This replaces the
   * earlier "raw JWTs are refused without the secret" rule: the path stays
   * open, but only the backend's own answer can open it.)
   */
  describe('no local secret configured (the deployed configuration)', () => {
    const mockFetch = jest.fn();

    beforeEach(() => {
      delete process.env.MCP_BACKEND_JWT_SECRET;
      mockFetch.mockReset();
      (global as unknown as { fetch: jest.Mock }).fetch = mockFetch;
    });

    const backendSays = (body: unknown, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    });

    it('REJECTS a forged bearer token — the backend refuses it', async () => {
      mockFetch.mockResolvedValue(backendSays({ statusCode: 401, message: 'Unauthorized' }, 401));
      const forged = makeJwt({ sub: 'attacker', role: 'admin', exp: FUTURE, jti: 'forged-prod' }, null);

      const result = await authMiddleware(bearerRequest(forged));

      expect(result).toMatchObject({ success: false, error: 'Invalid token', invalidCredentials: true });
      expect(result.token).toBeUndefined();
      // It was put to the backend, with the bearer, and not decoded-and-trusted.
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${forged}`);
    });

    it('REJECTS a genuine-looking JWT signed with some other key when the backend refuses it', async () => {
      mockFetch.mockResolvedValue(backendSays({ statusCode: 401, message: 'Unauthorized' }, 401));
      const genuineLooking = makeJwt({ sub: 'u1', role: 'renter', exp: FUTURE, jti: 'other-key' }, 'some-other-secret');

      const result = await authMiddleware(bearerRequest(genuineLooking));

      expect(result).toMatchObject({ success: false, error: 'Invalid token', invalidCredentials: true });
    });

    it('takes userId and role from the BACKEND, not from the client payload — and the session is a full-scope jwt principal', async () => {
      mockFetch.mockResolvedValue(backendSays({ id: 'real-user', role: 'renter' }));
      // The caller claims to be an admin named someone-else.
      const token = makeJwt({ sub: 'someone-else', role: 'admin', exp: FUTURE, jti: 'claims-swap' }, null);

      const result = await authMiddleware(bearerRequest(token));

      expect(result.success).toBe(true);
      expect(result.userId).toBe('real-user');
      expect(result.role).toBe('renter');
      expect(result.token).toBe(token);
      expect(result.kind).toBe('jwt');
      expect(result.scopes).toEqual([...TOOL_SCOPES]);
    });

    it('fails CLOSED when the backend cannot be reached', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const token = makeJwt({ sub: 'user-123', exp: FUTURE, jti: 'net-down' }, null);

      const result = await authMiddleware(bearerRequest(token));

      expect(result).toMatchObject({ success: false, error: 'Invalid token', invalidCredentials: true });
    });

    it('never calls the backend for the operator key path', async () => {
      const mockRequest = {
        headers: new Headers({ 'x-api-key': 'test-operator-key' }),
        nextUrl: { pathname: '/api/mcp' },
      } as any;

      const result = await authMiddleware(mockRequest);

      expect(result.success).toBe(true);
      expect(result.role).toBe('admin');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  it('rejects a non-operator x-api-key with no bearer', async () => {
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
  const mockFetch = jest.fn();
  beforeEach(() => {
    process.env.MCP_API_KEY = 'test-operator-key';
    process.env.MCP_OAUTH_SIGNING_KEY = KEY;
    // No local secret and a backend that would refuse: an envelope must never
    // need either — its provenance is the sealed payload, not a verification.
    delete process.env.MCP_BACKEND_JWT_SECRET;
    mockFetch.mockReset();
    (global as unknown as { fetch: jest.Mock }).fetch = mockFetch;
  });
  afterEach(() => { delete process.env.MCP_API_KEY; delete process.env.MCP_OAUTH_SIGNING_KEY; });

  it('accepts an MCP-issued access token and forwards the wrapped backend JWT, without any backend round-trip', async () => {
    const { issueTokens } = await import('../src/lib/oauth/tokens');
    const backend = makeJwt({ sub: 'user-9', role: 'vendor_owner', email: 'v@x.test', exp: FUTURE }, null);
    const tokens = issueTokens({ clientId: 'c1', user: { id: 'user-9', role: 'vendor_owner', email: 'v@x.test' }, backendAccessToken: backend, backendRefreshToken: 'brt', scopes: ['finance', 'read'] })!;
    const result = await authMiddleware({ headers: new Headers({ authorization: `Bearer ${tokens.access_token}` }), nextUrl: { pathname: '/api/mcp' } } as any);
    expect(result).toMatchObject({ success: true, userId: 'user-9', role: 'vendor_owner', email: 'v@x.test', token: backend, kind: 'oauth' });
    // The granted scopes ride along (canonical order) so the registry can filter tools/list.
    expect(result.scopes).toEqual(['read', 'finance']);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('carries an empty scope set through unchanged (a token that may use no tools)', async () => {
    const { issueTokens } = await import('../src/lib/oauth/tokens');
    const backend = makeJwt({ sub: 'user-9', role: 'renter', email: 'v@x.test', exp: FUTURE }, null);
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
    const expiredInner = makeJwt({ sub: 'u', role: 'renter', exp: Math.floor(Date.now() / 1000) + 1 }, null);
    const tokens = issueTokens({ clientId: 'c1', user: { id: 'u', role: 'renter', email: 'e' }, backendAccessToken: expiredInner, backendRefreshToken: 'r', scopes: ['read'] })!;
    await new Promise((r) => setTimeout(r, 1100));
    expect(openAccessToken(tokens.access_token)).toBeNull();
  });
});
