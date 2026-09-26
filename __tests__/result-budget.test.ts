import { MAX_RESULT_CHARS, toResultText } from '../src/tools/result-budget';
import { fail, ok } from '../src/tools/registry';

const listing = (i: number) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `Listing ${i}`, description: 'x'.repeat(900) });

describe('tool result budget', () => {
  it('renders compact JSON (no indentation) and strings as they are', () => {
    expect(toResultText({ a: 1, b: [1, 2] })).toBe('{"a":1,"b":[1,2]}');
    expect(toResultText('plain text')).toBe('plain text');
    expect(toResultText(undefined)).toBe('null');
  });

  it('leaves a result under the budget untouched', () => {
    const data = { listings: [listing(1), listing(2)], total: 2 };
    expect(toResultText(data)).toBe(JSON.stringify(data));
  });

  it('shortens the largest list of an oversized object, keeps valid JSON and says what it did', () => {
    const data = { total: 500, listings: Array.from({ length: 500 }, (_, i) => listing(i)), tags: ['a', 'b'] };
    const text = toResultText(data);
    expect(text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    const parsed = JSON.parse(text);
    expect(parsed.total).toBe(500);
    expect(parsed.tags).toEqual(['a', 'b']);
    expect(parsed.listings.length).toBeGreaterThan(10);
    expect(parsed.listings.length).toBeLessThan(500);
    expect(parsed.listings[0]).toEqual(listing(0));
    expect(parsed.resultTruncated).toMatchObject({ field: 'listings', returned: parsed.listings.length, total: 500 });
    expect(parsed.resultTruncated.note).toMatch(/fewer items/);
    // As many items as fit: one more would not.
    const oneMore = JSON.stringify({ ...data, listings: data.listings.slice(0, parsed.listings.length + 1), resultTruncated: { ...parsed.resultTruncated, returned: parsed.listings.length + 1 } });
    expect(oneMore.length).toBeGreaterThan(MAX_RESULT_CHARS);
  });

  it('wraps an oversized top-level list as { items, resultTruncated }', () => {
    const text = toResultText(Array.from({ length: 300 }, (_, i) => listing(i)));
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed.items)).toBe(true);
    expect(parsed.resultTruncated).toMatchObject({ returned: parsed.items.length, total: 300 });
    expect(text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
  });

  it('cuts anything else at the limit, with the notice, within the budget', () => {
    const text = toResultText({ blob: 'y'.repeat(MAX_RESULT_CHARS * 2) });
    expect(text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(text).toMatch(/more characters not shown/);
    const str = toResultText('z'.repeat(MAX_RESULT_CHARS + 10));
    expect(str.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(str).toMatch(/more characters not shown/);
  });

  it('is what ok() and fail() emit', () => {
    expect(ok({ a: 1 }).content[0]).toEqual({ type: 'text', text: '{"a":1}' });
    const failed = fail('Nope', { reason: 'r' });
    expect(failed.isError).toBe(true);
    expect(failed.content[0]).toEqual({ type: 'text', text: 'Nope\n{"reason":"r"}' });
    const huge = ok({ listings: Array.from({ length: 400 }, (_, i) => listing(i)) });
    expect((huge.content[0] as { text: string }).text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
  });
});
