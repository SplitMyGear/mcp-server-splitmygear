/**
 * Verification tests for lib/jwt.ts.
 *
 * The version these replace asserted the VULNERABILITY: with no
 * MCP_BACKEND_JWT_SECRET (the deployed configuration) a token signed `'sig'`
 * was "decoded" and trusted. Every case below now proves the opposite — an
 * unverifiable bearer is rejected on both paths.
 */
import crypto from 'crypto';
import { verifyBackendJwt } from '../src/lib/jwt';
import { backendBaseUrl } from '../src/lib/backend-client';

function b64url(o: object): string {
  return Buffer.from(JSON.stringify(o)).toString('base64url');
}
function makeToken(payload: object, secret?: string): string {
  const signingInput = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}`;
  const sig = secret ? crypto.createHmac('sha256', secret).update(signingInput).digest('base64url') : 'sig';
  return `${signingInput}.${sig}`;
}
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

const mockFetch = jest.fn();
function profileResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

describe('verifyBackendJwt', () => {
  const original = process.env.MCP_BACKEND_JWT_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    (global as unknown as { fetch: jest.Mock }).fetch = mockFetch;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.MCP_BACKEND_JWT_SECRET;
    else process.env.MCP_BACKEND_JWT_SECRET = original;
  });

  describe('shape + expiry (both paths)', () => {
    it('rejects a token that is not three segments', async () => {
      await expect(verifyBackendJwt('not-a-jwt')).resolves.toBeNull();
      await expect(verifyBackendJwt('only.two')).resolves.toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects a token whose payload is not a JSON object', async () => {
      const notAnObject = `${b64url({ alg: 'HS256' })}.${Buffer.from('"a string"').toString('base64url')}.sig`;
      await expect(verifyBackendJwt(notAnObject)).resolves.toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects a token whose payload segment is not decodable JSON', async () => {
      await expect(verifyBackendJwt('aaa.!!!not-base64-json!!!.bbb')).resolves.toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects an expired token without paying for an upstream call', async () => {
      delete process.env.MCP_BACKEND_JWT_SECRET;
      const expired = makeToken({ sub: 'u-expired', exp: Math.floor(Date.now() / 1000) - 1 });
      await expect(verifyBackendJwt(expired)).resolves.toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('local path (MCP_BACKEND_JWT_SECRET set)', () => {
    beforeEach(() => {
      process.env.MCP_BACKEND_JWT_SECRET = 'shared-secret';
    });

    it('accepts a correctly signed token and takes the identity from its claims', async () => {
      const token = makeToken({ sub: 'u1', role: 'vendor', exp: FUTURE }, 'shared-secret');
      await expect(verifyBackendJwt(token)).resolves.toEqual({ userId: 'u1', role: 'vendor' });
      // Proven locally: no network hop at all.
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('defaults the role when the verified token carries none', async () => {
      const token = makeToken({ sub: 'u-norole', exp: FUTURE }, 'shared-secret');
      await expect(verifyBackendJwt(token)).resolves.toEqual({ userId: 'u-norole', role: 'renter' });
    });

    it('rejects a token signed with the wrong key', async () => {
      const forged = makeToken({ sub: 'attacker', role: 'admin', exp: FUTURE }, 'wrong-secret');
      await expect(verifyBackendJwt(forged)).resolves.toBeNull();
    });

    it('rejects a token with a junk signature, and does NOT fall back to the backend', async () => {
      const forged = makeToken({ sub: 'attacker', role: 'admin', exp: FUTURE });
      await expect(verifyBackendJwt(forged)).resolves.toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects a correctly signed token with no sub', async () => {
      await expect(verifyBackendJwt(makeToken({ role: 'admin', exp: FUTURE }, 'shared-secret'))).resolves.toBeNull();
    });
  });

  describe('backend path (no secret configured — the production deployment)', () => {
    beforeEach(() => {
      delete process.env.MCP_BACKEND_JWT_SECRET;
    });

    it('REJECTS a forged token because the backend rejects it (the fixed vulnerability)', async () => {
      mockFetch.mockResolvedValue(profileResponse({ statusCode: 401, message: 'Unauthorized' }, 401));
      const forged = makeToken({ sub: 'attacker', role: 'admin', exp: FUTURE });
      await expect(verifyBackendJwt(forged)).resolves.toBeNull();
      // The forged claims were never trusted — the token was put to the backend.
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(`${backendBaseUrl()}/users/profile`);
      expect(init.headers.Authorization).toBe(`Bearer ${forged}`);
    });

    it('accepts a token the backend resolves, taking the identity from the RESPONSE', async () => {
      // The client's payload claims admin/other-user; the backend says otherwise.
      mockFetch.mockResolvedValue(profileResponse({ id: 'real-user', role: 'renter', email: 'a@b.c' }));
      const token = makeToken({ sub: 'claimed-someone-else', role: 'admin', exp: FUTURE });
      await expect(verifyBackendJwt(token)).resolves.toEqual({ userId: 'real-user', role: 'renter' });
    });

    it('rejects a 200 whose body carries no id (deleted account → null profile)', async () => {
      mockFetch.mockResolvedValue(profileResponse(null));
      await expect(verifyBackendJwt(makeToken({ sub: 'u-gone', exp: FUTURE }))).resolves.toBeNull();
    });

    it('fails CLOSED when the backend is unreachable', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(verifyBackendJwt(makeToken({ sub: 'u-netfail', exp: FUTURE }))).resolves.toBeNull();
    });

    it('fails CLOSED when the backend times out', async () => {
      mockFetch.mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
      await expect(verifyBackendJwt(makeToken({ sub: 'u-timeout', exp: FUTURE }))).resolves.toBeNull();
    });

    it('fails CLOSED on a backend 5xx', async () => {
      mockFetch.mockResolvedValue(profileResponse({ message: 'boom' }, 500));
      await expect(verifyBackendJwt(makeToken({ sub: 'u-5xx', exp: FUTURE }))).resolves.toBeNull();
    });

    it('bounds the identity probe with a tighter timeout than a tool call', async () => {
      mockFetch.mockResolvedValue(profileResponse({ id: 'u-signal', role: 'renter' }));
      await verifyBackendJwt(makeToken({ sub: 'u-signal', exp: FUTURE }));
      const [, init] = mockFetch.mock.calls[0];
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('caches a success, so a burst of calls costs ONE upstream round-trip', async () => {
      mockFetch.mockResolvedValue(profileResponse({ id: 'u-cached', role: 'vendor' }));
      const token = makeToken({ sub: 'u-cached', exp: FUTURE });

      const first = await verifyBackendJwt(token);
      const second = await verifyBackendJwt(token);
      const third = await verifyBackendJwt(token);

      expect(first).toEqual({ userId: 'u-cached', role: 'vendor' });
      expect(second).toEqual(first);
      expect(third).toEqual(first);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does not cache a rejection — a failed probe is retried, never remembered as a pass', async () => {
      mockFetch.mockResolvedValue(profileResponse({ message: 'Unauthorized' }, 401));
      const token = makeToken({ sub: 'u-uncached', exp: FUTURE });

      await expect(verifyBackendJwt(token)).resolves.toBeNull();
      await expect(verifyBackendJwt(token)).resolves.toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('never lets a cache entry outlive the token exp', async () => {
      // exp is 2s out, well inside the 60s TTL, so exp is what caps the entry.
      const shortExp = Math.floor(Date.now() / 1000) + 2;
      mockFetch.mockResolvedValue(profileResponse({ id: 'u-shortexp', role: 'renter' }));
      const token = makeToken({ sub: 'u-shortexp', exp: shortExp });

      await expect(verifyBackendJwt(token)).resolves.toEqual({ userId: 'u-shortexp', role: 'renter' });

      // Once exp passes, the token is rejected up front — the cached entry can
      // never resurrect it, and no further upstream call is made.
      jest.spyOn(Date, 'now').mockReturnValue(shortExp * 1000 + 1);
      await expect(verifyBackendJwt(token)).resolves.toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(1);
      jest.spyOn(Date, 'now').mockRestore();
    });

    it('bounds the cache — it cannot grow without limit under distinct tokens', async () => {
      // Fill past the 1000-entry guardrail with live (unexpired) entries, which
      // the sweep cannot reclaim; the cache must drop them rather than grow.
      mockFetch.mockResolvedValue(profileResponse({ id: 'u-bulk', role: 'renter' }));
      const first = makeToken({ sub: 'u-bulk', exp: FUTURE, jti: 'bulk-0' });
      await verifyBackendJwt(first);
      for (let i = 1; i <= 1_000; i++) {
        await verifyBackendJwt(makeToken({ sub: 'u-bulk', exp: FUTURE, jti: `bulk-${i}` }));
      }
      const callsBefore = mockFetch.mock.calls.length;

      // The earliest entry is gone, so it is re-verified rather than served stale.
      await expect(verifyBackendJwt(first)).resolves.toEqual({ userId: 'u-bulk', role: 'renter' });
      expect(mockFetch.mock.calls.length).toBe(callsBefore + 1);
    });

    it('keys the cache on a hash of the token, not the raw bearer', async () => {
      // Two different tokens for the same user must not share an entry.
      mockFetch
        .mockResolvedValueOnce(profileResponse({ id: 'u-two', role: 'renter' }))
        .mockResolvedValueOnce(profileResponse({ id: 'u-two', role: 'renter' }));
      await verifyBackendJwt(makeToken({ sub: 'u-two', exp: FUTURE, jti: 'a' }));
      await verifyBackendJwt(makeToken({ sub: 'u-two', exp: FUTURE, jti: 'b' }));
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});
