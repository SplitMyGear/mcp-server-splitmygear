import {
  rateLimiter,
  RATE_LIMITS,
  FAIL_OPEN_MARKER,
  __setRateLimitClientForTests,
} from '../src/middleware/rate-limit';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * SPLIT-373: the limiter is now backed by a DURABLE shared Postgres store
 * (atomic `mcp_rate_limit_hit` RPC), not a per-instance Map. These tests inject
 * a mock Supabase client via `__setRateLimitClientForTests` and assert:
 *   (a) an under-limit request passes,
 *   (b) an over-limit request is blocked,
 *   (c) a store error makes the limiter FAIL OPEN (request allowed) and logs the
 *       `mcp.ratelimit.fail_open` ERROR marker.
 * Per-client isolation is delegated to the SQL key (clientId, windowStart); the
 * counter the RPC returns is what drives the success/block decision here.
 */

/**
 * Builds a mock Supabase client whose `.rpc()` returns the given per-client
 * counter sequence. The real RPC returns the NEW window count for the caller;
 * the mock simulates that by maintaining an in-memory counter keyed by the
 * `p_client_id` argument, so different client ids stay isolated.
 */
function mockClientWithCounter(): {
  client: SupabaseClient;
  rpc: jest.Mock;
} {
  const counters = new Map<string, number>();
  const rpc = jest.fn(async (_fn: string, params: { p_client_id: string }) => {
    const next = (counters.get(params.p_client_id) || 0) + 1;
    counters.set(params.p_client_id, next);
    return { data: next, error: null };
  });
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

describe('Rate Limiter Middleware (durable store, SPLIT-373)', () => {
  const originalEnv = process.env;
  const req = new NextRequest('http://localhost/api/mcp');

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, MCP_RATE_LIMIT_TIER: 'public' };
    __setRateLimitClientForTests(undefined); // reset cache between tests
  });

  afterEach(() => {
    process.env = originalEnv;
    __setRateLimitClientForTests(undefined);
  });

  it('(a) allows an under-limit request', async () => {
    const { client, rpc } = mockClientWithCounter();
    __setRateLimitClientForTests(client);

    const result = await rateLimiter(req, 'client-under');
    expect(result.success).toBe(true);
    expect(result.remaining).toBe(RATE_LIMITS.public.requestsPerMinute - 1);
    expect(rpc).toHaveBeenCalledWith('mcp_rate_limit_hit', {
      p_client_id: 'client-under',
      p_window_ms: 60_000,
    });
  });

  it('(b) blocks once the durable counter exceeds the tier limit', async () => {
    const { client } = mockClientWithCounter();
    __setRateLimitClientForTests(client);
    const limit = RATE_LIMITS.public.requestsPerMinute;

    // Exhaust exactly the configured limit (derived, not hardcoded).
    for (let i = 0; i < limit; i++) {
      const r = await rateLimiter(req, 'client-exceed');
      expect(r.success).toBe(true);
    }

    const blocked = await rateLimiter(req, 'client-exceed');
    expect(blocked.success).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.error).toContain('Rate limit exceeded');
  });

  it('isolates counts per client id (shared store keyed by clientId)', async () => {
    const { client } = mockClientWithCounter();
    __setRateLimitClientForTests(client);

    for (let i = 0; i < RATE_LIMITS.public.requestsPerMinute; i++) {
      await rateLimiter(req, 'client-a');
    }
    // A different client is unaffected by client-a's exhaustion.
    const other = await rateLimiter(req, 'client-b');
    expect(other.success).toBe(true);
  });

  it('(c) FAILS OPEN and logs the marker when the RPC returns an error', async () => {
    const rpc = jest
      .fn()
      .mockResolvedValue({ data: null, error: { message: 'pg down' } });
    __setRateLimitClientForTests({ rpc } as unknown as SupabaseClient);
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await rateLimiter(req, 'client-store-error');

    expect(result.success).toBe(true); // never blocks on store failure
    expect(result.remaining).toBe(RATE_LIMITS.public.requestsPerMinute);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining(FAIL_OPEN_MARKER)
    );
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('store_error'));
    errSpy.mockRestore();
  });

  it('(c) FAILS OPEN and logs the marker when the RPC throws', async () => {
    const rpc = jest.fn().mockRejectedValue(new Error('network timeout'));
    __setRateLimitClientForTests({ rpc } as unknown as SupabaseClient);
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await rateLimiter(req, 'client-throw');

    expect(result.success).toBe(true);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining(FAIL_OPEN_MARKER)
    );
    errSpy.mockRestore();
  });

  it('fails open with the marker when the durable store is not configured', async () => {
    // No SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env => getClient() === null.
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    __setRateLimitClientForTests(null);
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await rateLimiter(req, 'client-unconfigured');

    expect(result.success).toBe(true);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('store_not_configured')
    );
    errSpy.mockRestore();
  });
});
