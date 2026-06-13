/**
 * SPLIT-253 M6 — PostgREST `.or()` filter injection hardening for listing search
 * and availability. Captures the exact filter string handed to Supabase and
 * proves user input can no longer break out of the filter token.
 */
import { listingTools } from '../src/tools/listings';

const orSpy = jest.fn();

jest.mock('../src/lib/ai-service', () => ({
  aiService: {
    // Return no structured filters so the keyword `.or()` branch is exercised,
    // and an empty embedding so the vector-RPC path is skipped.
    parseSearchQuery: jest.fn().mockResolvedValue({}),
    generateEmbedding: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../src/lib/supabase', () => {
  const builder: any = {
    select: jest.fn(() => builder),
    eq: jest.fn(() => builder),
    neq: jest.fn(() => builder),
    ilike: jest.fn(() => builder),
    gte: jest.fn(() => builder),
    lte: jest.fn(() => builder),
    or: jest.fn((arg: string) => {
      orSpy(arg);
      return builder;
    }),
    in: jest.fn(() => builder),
    not: jest.fn(() => builder),
    order: jest.fn(() => builder),
    limit: jest.fn().mockResolvedValue({ data: [], error: null }),
    // A valid listing so checkAvailability proceeds past the lookup to the
    // date guard + booking `.or()`.
    single: jest
      .fn()
      .mockResolvedValue({ data: { id: 'listing-x', maxGuests: 10 }, error: null }),
    then: jest.fn((cb: any) => Promise.resolve(cb({ data: [], error: null }))),
  };
  return {
    supabase: {
      from: jest.fn(() => builder),
      rpc: jest.fn().mockResolvedValue({ data: [], error: null }),
    },
  };
});

beforeEach(() => orSpy.mockClear());

describe('M6: search query .or() injection (SPLIT-253)', () => {
  it('strips PostgREST breakout characters from a malicious query', async () => {
    const malicious = 'bike%,price.gte.0),name.ilike.%(';
    await listingTools.searchListings({ query: malicious });

    expect(orSpy).toHaveBeenCalledTimes(1);
    const filter = orSpy.mock.calls[0][0] as string;
    // The grouping chars that would let input restructure the filter are gone,
    // so the leftover text can only ever be a literal LIKE pattern, never a
    // new filter condition.
    expect(filter).not.toContain('(');
    expect(filter).not.toContain(')');
    // Still a well-formed two-condition ilike on name + description.
    expect(filter).toMatch(/^name\.ilike\.%.*%,description\.ilike\.%.*%$/);
    // Exactly the ONE structural comma separating name/description — no more,
    // so no extra OR condition can be injected.
    expect((filter.match(/,/g) || []).length).toBe(1);
  });

  it('skips the .or() entirely when the query sanitizes to empty', async () => {
    await listingTools.searchListings({ query: '(),' });
    expect(orSpy).not.toHaveBeenCalled();
  });

  it('passes a benign query through unchanged (no over-stripping)', async () => {
    await listingTools.searchListings({ query: 'mountain bike' });
    const filter = orSpy.mock.calls[0][0] as string;
    expect(filter).toBe(
      'name.ilike.%mountain bike%,description.ilike.%mountain bike%',
    );
  });
});

describe('M6: checkAvailability date guard (SPLIT-253)', () => {
  it('rejects a non-ISO checkIn that carries filter-injection characters', async () => {
    await expect(
      listingTools.checkAvailability(
        '3d7a89e5-9c3c-4b77-afea-102f1f126113',
        '2026-01-01),status.eq.confirmed',
        '2026-01-05',
        2,
      ),
    ).rejects.toThrow(/Invalid checkIn/);
  });

  it('accepts well-formed ISO dates without throwing', async () => {
    const result = await listingTools.checkAvailability(
      '3d7a89e5-9c3c-4b77-afea-102f1f126113',
      '2026-01-01',
      '2026-01-05',
      2,
    );
    expect(result).toHaveProperty('available');
  });
});
