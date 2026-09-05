/**
 * The hosted sign-in throttle and the authorization-code replay cache, in
 * both of their modes: backed by the shared store (Upstash REST, mocked
 * fetch) and the per-instance fallback when no store is configured or the
 * store is unavailable.
 */
export {};
import { isThrottled, recordAttempt, clearAttempts, _resetThrottle } from '../../src/lib/oauth/throttle';
import { markCodeRedeemed } from '../../src/lib/oauth/tokens';
import { _resetSharedStoreForTests } from '../../src/lib/shared-store';

const STORE_URL = 'https://example-redis.upstash.io';
const STORE_TOKEN = 'test-store-token';
const STORE_ENV = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN'];
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function makeResponse(ok: boolean, status: number, body: unknown) {
  return { ok, status, text: async () => JSON.stringify(body) };
}
/** Upstash pipeline reply for INCR + EXPIRE. */
function pipelineCount(count: number) {
  return makeResponse(true, 200, [{ result: count }, { result: 1 }]);
}
/** Upstash single-command reply. */
function single(result: unknown) {
  return makeResponse(true, 200, { result });
}

describe('sign-in throttle', () => {
  const originalEnv = process.env;
  let mockFetch: jest.Mock;

  function enableStore() {
    process.env.UPSTASH_REDIS_REST_URL = STORE_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = STORE_TOKEN;
  }
  function call(index = 0) {
    const [url, init] = mockFetch.mock.calls[index] as [string, RequestInit];
    return { url, body: JSON.parse(init.body as string) as unknown, headers: init.headers as Record<string, string> };
  }

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const name of STORE_ENV) delete process.env[name];
    mockFetch = jest.fn();
    (global as unknown as { fetch: jest.Mock }).fetch = mockFetch;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    _resetSharedStoreForTests();
    _resetThrottle();
  });
  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  describe('in-memory (no shared store configured)', () => {
    it('trips after MAX_ATTEMPTS recorded failures, per key, without touching the network', async () => {
      const now = 1_700_000_000_000;
      expect(await isThrottled('ip:203.0.113.9', now)).toBe(false);
      for (let i = 0; i < MAX_ATTEMPTS - 1; i++) await recordAttempt('ip:203.0.113.9', now);
      expect(await isThrottled('ip:203.0.113.9', now)).toBe(false);
      await recordAttempt('ip:203.0.113.9', now);
      expect(await isThrottled('ip:203.0.113.9', now)).toBe(true);
      // Checks do not consume budget locally, and other keys are unaffected.
      expect(await isThrottled('ip:203.0.113.9', now)).toBe(true);
      expect(await isThrottled('ip:203.0.113.10', now)).toBe(false);
      expect(await isThrottled('email:victim@x.test', now)).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('forgets a key once its ten-minute window has passed, and restarts the count', async () => {
      const now = 1_700_000_000_000;
      for (let i = 0; i < MAX_ATTEMPTS; i++) await recordAttempt('ip:1.1.1.1', now);
      expect(await isThrottled('ip:1.1.1.1', now + WINDOW_MS - 1)).toBe(true);
      expect(await isThrottled('ip:1.1.1.1', now + WINDOW_MS + 1)).toBe(false);
      await recordAttempt('ip:1.1.1.1', now + WINDOW_MS + 1);
      expect(await isThrottled('ip:1.1.1.1', now + WINDOW_MS + 2)).toBe(false);
    });

    it('supports clearing one key and resetting everything (test hook)', async () => {
      const now = Date.now();
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        await recordAttempt('a', now);
        await recordAttempt('b', now);
      }
      clearAttempts('a');
      expect(await isThrottled('a', now)).toBe(false);
      expect(await isThrottled('b', now)).toBe(true);
      _resetThrottle();
      expect(await isThrottled('b', now)).toBe(false);
    });
  });

  describe('shared store', () => {
    it('reads the window counter on a check (GET, no increment) and refuses at the failure budget', async () => {
      enableStore();
      const now = 1_700_000_000_000;
      const windowId = Math.floor(now / WINDOW_MS);
      mockFetch.mockResolvedValueOnce(single(null));
      expect(await isThrottled('ip:203.0.113.9', now)).toBe(false);
      expect(call(0).url).toBe(STORE_URL);
      expect(call(0).headers.Authorization).toBe(`Bearer ${STORE_TOKEN}`);
      expect(call(0).body).toEqual(['GET', `mcp:login:ip:203.0.113.9:${windowId}`]);

      mockFetch.mockResolvedValueOnce(single(MAX_ATTEMPTS - 1));
      expect(await isThrottled('ip:203.0.113.9', now)).toBe(false); // nine failures: still allowed
      mockFetch.mockResolvedValueOnce(single(MAX_ATTEMPTS));
      expect(await isThrottled('ip:203.0.113.9', now)).toBe(true);
      mockFetch.mockResolvedValueOnce(single('500'));
      expect(await isThrottled('email:victim@x.test', now)).toBe(true);
      expect(call(3).body).toEqual(['GET', `mcp:login:email:victim@x.test:${windowId}`]);
    });

    it('records a FAILURE with INCR + EXPIRE NX on the window key, and locally too', async () => {
      enableStore();
      const now = 1_700_000_000_000;
      const windowId = Math.floor(now / WINDOW_MS);
      mockFetch.mockResolvedValueOnce(pipelineCount(1));
      await recordAttempt('ip:9.9.9.9', now);
      expect(call(0).url).toBe(`${STORE_URL}/pipeline`);
      expect(call(0).body).toEqual([
        ['INCR', `mcp:login:ip:9.9.9.9:${windowId}`],
        ['EXPIRE', `mcp:login:ip:9.9.9.9:${windowId}`, 600, 'NX'],
      ]);
      // Successful sign-ins never touch the store: only the caller's explicit failure records do.
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('keys the counter on the ten-minute window', async () => {
      enableStore();
      const now = 1_700_000_000_000;
      mockFetch.mockResolvedValue(single(0));
      await isThrottled('k', now);
      await isThrottled('k', now + WINDOW_MS);
      const key = (i: number) => (call(i).body as string[])[1];
      expect(key(0)).toBe(`mcp:login:k:${Math.floor(now / WINDOW_MS)}`);
      expect(key(1)).toBe(`mcp:login:k:${Math.floor(now / WINDOW_MS) + 1}`);
      expect(key(0)).not.toBe(key(1));
    });

    it('falls back to the per-instance failure count when the store is unavailable', async () => {
      enableStore();
      const now = Date.now();
      mockFetch.mockRejectedValue(new Error('ECONNRESET'));
      expect(await isThrottled('ip:5.5.5.5', now)).toBe(false);
      for (let i = 0; i < MAX_ATTEMPTS; i++) await recordAttempt('ip:5.5.5.5', now);
      expect(await isThrottled('ip:5.5.5.5', now)).toBe(true);
      expect(await isThrottled('ip:6.6.6.6', now)).toBe(false);

      // A non-2xx answer, a command error and a malformed reply are all "unavailable".
      mockFetch.mockResolvedValueOnce(makeResponse(false, 500, {}));
      expect(await isThrottled('ip:5.5.5.5', now)).toBe(true);
      mockFetch.mockResolvedValueOnce(makeResponse(true, 200, { error: 'WRONGTYPE' }));
      expect(await isThrottled('ip:6.6.6.6', now)).toBe(false);
      mockFetch.mockResolvedValueOnce(makeResponse(true, 200, { result: 'not-a-number' }));
      expect(await isThrottled('ip:6.6.6.6', now)).toBe(false);
    });
  });
});

describe('authorization-code replay cache', () => {
  const originalEnv = process.env;
  let mockFetch: jest.Mock;
  const exp = () => Math.floor(Date.now() / 1000) + 120;
  const jti = (tag: string) => `${tag}-${Math.random().toString(36).slice(2)}`;

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const name of STORE_ENV) delete process.env[name];
    mockFetch = jest.fn();
    (global as unknown as { fetch: jest.Mock }).fetch = mockFetch;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    _resetSharedStoreForTests();
  });
  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('is per instance without a store: first use passes, replay is refused', async () => {
    const id = jti('local');
    expect(await markCodeRedeemed(id, exp())).toBe(true);
    expect(await markCodeRedeemed(id, exp())).toBe(false);
    expect(await markCodeRedeemed(jti('other'), exp())).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('uses SET NX under mcp:code:<jti> with the code lifetime as TTL when a store is configured', async () => {
    process.env.UPSTASH_REDIS_REST_URL = STORE_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = STORE_TOKEN;
    const id = jti('shared');
    const e = exp();
    mockFetch.mockResolvedValueOnce(single('OK'));
    expect(await markCodeRedeemed(id, e)).toBe(true);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(STORE_URL);
    const body = JSON.parse(init.body as string) as unknown[];
    expect(body.slice(0, 4)).toEqual(['SET', `mcp:code:${id}`, '1', 'EX']);
    expect(body[4]).toBeGreaterThanOrEqual(118);
    expect(body[4]).toBeLessThanOrEqual(120);
    expect(body[5]).toBe('NX');

    // Another instance already redeemed it (Redis answers nil to SET NX).
    mockFetch.mockResolvedValueOnce(single(null));
    expect(await markCodeRedeemed(jti('elsewhere'), e)).toBe(false);
  });

  it('refuses a replay locally even if the store would accept it, and falls back to the local set when the store is down', async () => {
    process.env.UPSTASH_REDIS_REST_URL = STORE_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = STORE_TOKEN;
    const id = jti('mixed');
    mockFetch.mockResolvedValue(single('OK'));
    expect(await markCodeRedeemed(id, exp())).toBe(true);
    expect(await markCodeRedeemed(id, exp())).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1); // the local hit short-circuits the store

    const down = jti('down');
    mockFetch.mockRejectedValue(new Error('timeout'));
    expect(await markCodeRedeemed(down, exp())).toBe(true);
    expect(await markCodeRedeemed(down, exp())).toBe(false);
  });
});
