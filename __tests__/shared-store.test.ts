import {
  _resetSharedStoreForTests,
  incrementWindow,
  namespacedKey,
  redeemOnce,
  setIfAbsent,
  sharedStoreEnabled,
  getCount,
} from '../src/lib/shared-store';

const STORE_URL = 'https://example-redis.upstash.io';
const STORE_TOKEN = 'test-store-token';
const STORE_ENV = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN'];

/** Mirrors the shape the module reads (ok/status/text), like backend-client.test.ts. */
function makeResponse(ok: boolean, status: number, body: unknown) {
  return {
    ok,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function pipelineOk(...results: unknown[]) {
  return makeResponse(true, 200, results.map((result) => ({ result })));
}

describe('shared store (Upstash Redis REST)', () => {
  const originalEnv = process.env;
  let mockFetch: jest.Mock;
  let warnSpy: jest.SpyInstance;

  function enableUpstash(url: string = STORE_URL) {
    process.env.UPSTASH_REDIS_REST_URL = url;
    process.env.UPSTASH_REDIS_REST_TOKEN = STORE_TOKEN;
  }

  function call(index = 0) {
    const [url, init] = mockFetch.mock.calls[index] as [string, RequestInit];
    return { url, init, body: JSON.parse(init.body as string) as unknown, headers: init.headers as Record<string, string> };
  }

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const name of STORE_ENV) delete process.env[name];
    mockFetch = jest.fn();
    (global as unknown as { fetch: jest.Mock }).fetch = mockFetch;
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    _resetSharedStoreForTests();
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  describe('configuration', () => {
    it('is disabled when no credentials are set', () => {
      expect(sharedStoreEnabled()).toBe(false);
    });

    it('is enabled with the Upstash pair', () => {
      enableUpstash();
      expect(sharedStoreEnabled()).toBe(true);
    });

    it('falls back to the Vercel KV pair', () => {
      process.env.KV_REST_API_URL = 'https://kv.example.vercel-storage.com';
      process.env.KV_REST_API_TOKEN = 'kv-token';
      expect(sharedStoreEnabled()).toBe(true);
    });

    it('treats a half-configured pair as disabled', () => {
      process.env.UPSTASH_REDIS_REST_URL = STORE_URL;
      expect(sharedStoreEnabled()).toBe(false);
      delete process.env.UPSTASH_REDIS_REST_URL;
      process.env.UPSTASH_REDIS_REST_TOKEN = STORE_TOKEN;
      expect(sharedStoreEnabled()).toBe(false);
    });

    it('uses the KV pair when the Upstash pair is incomplete', async () => {
      process.env.UPSTASH_REDIS_REST_URL = STORE_URL; // no token
      process.env.KV_REST_API_URL = 'https://kv.example.vercel-storage.com/';
      process.env.KV_REST_API_TOKEN = 'kv-token';
      mockFetch.mockResolvedValue(pipelineOk(1, 1));

      await incrementWindow('rl:a', 60);

      expect(call().url).toBe('https://kv.example.vercel-storage.com/pipeline');
      expect(call().headers.Authorization).toBe('Bearer kv-token');
    });

    it('resolves null from every primitive without calling fetch when disabled', async () => {
      await expect(incrementWindow('rl:a', 60)).resolves.toBeNull();
      await expect(setIfAbsent('code:a', 60)).resolves.toBeNull();
      await expect(redeemOnce('code:a', 60)).resolves.toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('namespacedKey', () => {
    it('prefixes keys with mcp: exactly once', () => {
      expect(namespacedKey('rl:user:1')).toBe('mcp:rl:user:1');
      expect(namespacedKey('mcp:rl:user:1')).toBe('mcp:rl:user:1');
    });
  });

  describe('incrementWindow', () => {
    beforeEach(() => enableUpstash());

    it('sends INCR + EXPIRE NX as one pipeline with bearer auth and returns the count', async () => {
      mockFetch.mockResolvedValue(pipelineOk(7, 0));
      const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');

      const count = await incrementWindow('rl:user:abc:123', 60);

      expect(count).toBe(7);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const { url, init, body, headers } = call();
      expect(url).toBe(`${STORE_URL}/pipeline`);
      expect(init.method).toBe('POST');
      expect(headers.Authorization).toBe(`Bearer ${STORE_TOKEN}`);
      expect(headers['Content-Type']).toBe('application/json');
      expect(body).toEqual([
        ['INCR', 'mcp:rl:user:abc:123'],
        ['EXPIRE', 'mcp:rl:user:abc:123', 60, 'NX'],
      ]);
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(timeoutSpy).toHaveBeenCalledWith(1500);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not double-prefix a key that already carries mcp:', async () => {
      mockFetch.mockResolvedValue(pipelineOk(1, 1));
      await incrementWindow('mcp:rl:x', 60);
      expect((call().body as unknown[][])[0]).toEqual(['INCR', 'mcp:rl:x']);
    });

    it('strips a trailing slash from the configured URL', async () => {
      enableUpstash(`${STORE_URL}/`);
      mockFetch.mockResolvedValue(pipelineOk(1, 1));
      await incrementWindow('rl:x', 60);
      expect(call().url).toBe(`${STORE_URL}/pipeline`);
    });

    it('clamps the window to a positive whole number of seconds', async () => {
      mockFetch.mockResolvedValue(pipelineOk(1, 1));
      await incrementWindow('rl:x', 0.4);
      expect((call(0).body as unknown[][])[1]).toEqual(['EXPIRE', 'mcp:rl:x', 1, 'NX']);
      await incrementWindow('rl:y', 59.2);
      expect((call(1).body as unknown[][])[1]).toEqual(['EXPIRE', 'mcp:rl:y', 60, 'NX']);
    });

    it('accepts a numeric string INCR result', async () => {
      mockFetch.mockResolvedValue(pipelineOk('12', 0));
      await expect(incrementWindow('rl:x', 60)).resolves.toBe(12);
    });

    it('falls back to a plain EXPIRE when the server rejects NX on the first hit', async () => {
      mockFetch
        .mockResolvedValueOnce(makeResponse(true, 200, [{ result: 1 }, { error: 'ERR syntax error' }]))
        .mockResolvedValueOnce(makeResponse(true, 200, { result: 1 }));

      const count = await incrementWindow('rl:x', 60);

      expect(count).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(call(1).url).toBe(STORE_URL);
      expect(call(1).body).toEqual(['EXPIRE', 'mcp:rl:x', 60]);
      expect(call(1).headers.Authorization).toBe(`Bearer ${STORE_TOKEN}`);
    });

    it('does not re-EXPIRE on later hits when NX is rejected (the window must not slide)', async () => {
      mockFetch.mockResolvedValue(makeResponse(true, 200, [{ result: 5 }, { error: 'ERR syntax error' }]));

      const count = await incrementWindow('rl:x', 60);

      expect(count).toBe(5);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('still returns the count when the fallback EXPIRE itself fails', async () => {
      mockFetch
        .mockResolvedValueOnce(makeResponse(true, 200, [{ result: 1 }, { error: 'ERR syntax error' }]))
        .mockRejectedValueOnce(new TypeError('fetch failed'));

      await expect(incrementWindow('rl:x', 60)).resolves.toBe(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('fails open (null) when INCR itself errors', async () => {
      mockFetch.mockResolvedValue(makeResponse(true, 200, [{ error: 'WRONGTYPE' }, { result: 0 }]));
      await expect(incrementWindow('rl:x', 60)).resolves.toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('fails open on a non-numeric INCR result', async () => {
      mockFetch.mockResolvedValue(pipelineOk('OK', 0));
      await expect(incrementWindow('rl:x', 60)).resolves.toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('fails open on a non-2xx response', async () => {
      mockFetch.mockResolvedValue(makeResponse(false, 401, { error: 'Unauthorized' }));
      await expect(incrementWindow('rl:x', 60)).resolves.toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain('HTTP 401');
    });

    it('fails open on a timeout', async () => {
      const timeout = new Error('The operation was aborted due to timeout');
      timeout.name = 'TimeoutError';
      mockFetch.mockRejectedValue(timeout);
      await expect(incrementWindow('rl:x', 60)).resolves.toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain('TimeoutError');
    });

    it('fails open on a network error', async () => {
      mockFetch.mockRejectedValue(new TypeError('fetch failed'));
      await expect(incrementWindow('rl:x', 60)).resolves.toBeNull();
    });

    it('fails open on a non-JSON body', async () => {
      mockFetch.mockResolvedValue(makeResponse(true, 200, '<html>bad gateway</html>'));
      await expect(incrementWindow('rl:x', 60)).resolves.toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('fails open when the pipeline reply does not match the command count', async () => {
      mockFetch.mockResolvedValue(pipelineOk(1));
      await expect(incrementWindow('rl:x', 60)).resolves.toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('fails open on an empty body', async () => {
      mockFetch.mockResolvedValue(makeResponse(true, 200, ''));
      await expect(incrementWindow('rl:x', 60)).resolves.toBeNull();
    });
  });

  describe('setIfAbsent / redeemOnce', () => {
    beforeEach(() => enableUpstash());

    it('sends SET key 1 EX ttl NX as a single command and reports true when set', async () => {
      mockFetch.mockResolvedValue(makeResponse(true, 200, { result: 'OK' }));

      await expect(setIfAbsent('code:abc', 600)).resolves.toBe(true);

      const { url, init, body, headers } = call();
      expect(url).toBe(STORE_URL);
      expect(init.method).toBe('POST');
      expect(headers.Authorization).toBe(`Bearer ${STORE_TOKEN}`);
      expect(body).toEqual(['SET', 'mcp:code:abc', '1', 'EX', 600, 'NX']);
    });

    it('reports false when the key already exists (nil reply)', async () => {
      mockFetch.mockResolvedValue(makeResponse(true, 200, { result: null }));
      await expect(setIfAbsent('code:abc', 600)).resolves.toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('fails open on a command error', async () => {
      mockFetch.mockResolvedValue(makeResponse(true, 200, { error: 'ERR max requests limit exceeded' }));
      await expect(setIfAbsent('code:abc', 600)).resolves.toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('fails open on a non-2xx response', async () => {
      mockFetch.mockResolvedValue(makeResponse(false, 503, 'unavailable'));
      await expect(setIfAbsent('code:abc', 600)).resolves.toBeNull();
    });

    it('fails open on an unexpected reply shape', async () => {
      mockFetch.mockResolvedValue(makeResponse(true, 200, [{ result: 'OK' }]));
      await expect(setIfAbsent('code:abc', 600)).resolves.toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('redeemOnce is true the first time and false on a replay', async () => {
      mockFetch
        .mockResolvedValueOnce(makeResponse(true, 200, { result: 'OK' }))
        .mockResolvedValueOnce(makeResponse(true, 200, { result: null }));

      await expect(redeemOnce('code:xyz', 300)).resolves.toBe(true);
      await expect(redeemOnce('code:xyz', 300)).resolves.toBe(false);
      expect(call(0).body).toEqual(['SET', 'mcp:code:xyz', '1', 'EX', 300, 'NX']);
      expect(call(1).body).toEqual(call(0).body);
    });

    it('redeemOnce fails open when the store is down', async () => {
      mockFetch.mockRejectedValue(new TypeError('fetch failed'));
      await expect(redeemOnce('code:xyz', 300)).resolves.toBeNull();
    });
  });

  describe('warning throttle', () => {
    beforeEach(() => enableUpstash());

    it('warns at most once per minute per instance and never logs the key or token', async () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
      mockFetch.mockRejectedValue(new TypeError('fetch failed'));

      await incrementWindow('rl:user:secret-user-id', 60);
      await incrementWindow('rl:user:secret-user-id', 60);
      await setIfAbsent('code:secret-code', 60);
      expect(warnSpy).toHaveBeenCalledTimes(1);

      const message = String(warnSpy.mock.calls[0][0]);
      expect(message).not.toContain('secret-user-id');
      expect(message).not.toContain('secret-code');
      expect(message).not.toContain(STORE_TOKEN);
      expect(message).toContain('per-instance fallback');

      nowSpy.mockReturnValue(1_700_000_000_000 + 59_000);
      await incrementWindow('rl:x', 60);
      expect(warnSpy).toHaveBeenCalledTimes(1);

      nowSpy.mockReturnValue(1_700_000_000_000 + 60_000);
      await incrementWindow('rl:x', 60);
      expect(warnSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('getCount', () => {
    it('reads a counter with GET, treats a missing key as 0, and fails open', async () => {
      enableUpstash();
      mockFetch.mockResolvedValueOnce(makeResponse(true, 200, { result: null }));
      expect(await getCount('login:k')).toBe(0);
      expect(call(0).url).toBe(STORE_URL);
      expect(call(0).body).toEqual(['GET', 'mcp:login:k']);
      mockFetch.mockResolvedValueOnce(makeResponse(true, 200, { result: 7 }));
      expect(await getCount('mcp:login:k')).toBe(7);
      mockFetch.mockResolvedValueOnce(makeResponse(true, 200, { result: 'nope' }));
      expect(await getCount('login:k')).toBeNull();
      mockFetch.mockRejectedValueOnce(new Error('down'));
      expect(await getCount('login:k')).toBeNull();
      for (const name of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[name];
      expect(await getCount('login:k')).toBeNull();
    });
  });
});
