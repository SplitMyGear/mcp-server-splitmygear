export {};

import crypto from 'crypto';
import { authMiddleware } from '../src/middleware/auth';

const JWT_SECRET = 'test-backend-jwt-secret';

// Build a backend-style JWT (HS256, claims = { sub, role, exp }). `secret`
// omitted ⇒ a junk signature, i.e. the forgery an attacker can mint: a header,
// any claims they like, and whatever trailing segment they please.
function makeJwt(payload: Record<string, unknown>, secret?: string): string {
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
    const token = makeJwt({ sub: 'user-123', role: 'vendor', exp: FUTURE }, JWT_SECRET);

    const result = await authMiddleware(bearerRequest(token));

    expect(result.success).toBe(true);
    expect(result.userId).toBe('user-123');
    expect(result.role).toBe('vendor');
    // The raw token must be surfaced so user-scoped tools can forward it.
    expect(result.token).toBe(token);
  });

  /**
   * THE REGRESSION RAIL. This case previously asserted the opposite — a token
   * with the literal signature `'sig'` was accepted as `user-123`/`vendor`,
   * encoding the vulnerability into the suite. A forged bearer must be denied
   * on every path, including the no-secret deployment covered below.
   */
  it('REJECTS a forged bearer token (valid shape, junk signature)', async () => {
    const forged = makeJwt({ sub: 'user-123', role: 'admin', exp: FUTURE });

    const result = await authMiddleware(bearerRequest(forged));

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid token');
    expect(result.userId).toBeUndefined();
    expect(result.role).toBeUndefined();
    expect(result.token).toBeUndefined();
  });

  it('REJECTS a bearer token signed with the wrong key', async () => {
    const forged = makeJwt({ sub: 'attacker', role: 'admin', exp: FUTURE }, 'not-the-backend-secret');

    const result = await authMiddleware(bearerRequest(forged));

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid token');
  });

  it('rejects a malformed bearer token (not a JWT)', async () => {
    const result = await authMiddleware(bearerRequest('not-a-jwt'));

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid token');
  });

  it('rejects an expired backend JWT even when correctly signed', async () => {
    const token = makeJwt(
      { sub: 'user-123', role: 'renter', exp: Math.floor(Date.now() / 1000) - 60 },
      JWT_SECRET,
    );

    const result = await authMiddleware(bearerRequest(token));

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid token');
  });

  /**
   * The PRODUCTION configuration: `MCP_BACKEND_JWT_SECRET` is not set on the
   * Vercel project, so identity is resolved against the backend itself. The
   * forged-token case here is the one that was live.
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
      const forged = makeJwt({ sub: 'attacker', role: 'admin', exp: FUTURE, jti: 'forged-prod' });

      const result = await authMiddleware(bearerRequest(forged));

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid token');
      expect(result.token).toBeUndefined();
    });

    it('takes userId and role from the BACKEND, not from the client payload', async () => {
      mockFetch.mockResolvedValue(backendSays({ id: 'real-user', role: 'renter' }));
      // The caller claims to be an admin named someone-else.
      const token = makeJwt({ sub: 'someone-else', role: 'admin', exp: FUTURE, jti: 'claims-swap' });

      const result = await authMiddleware(bearerRequest(token));

      expect(result.success).toBe(true);
      expect(result.userId).toBe('real-user');
      expect(result.role).toBe('renter');
      expect(result.token).toBe(token);
    });

    it('fails CLOSED when the backend cannot be reached', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const token = makeJwt({ sub: 'user-123', exp: FUTURE, jti: 'net-down' });

      const result = await authMiddleware(bearerRequest(token));

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid token');
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
