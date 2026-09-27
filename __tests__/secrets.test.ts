const mockBackendRequest = jest.fn();
jest.mock('../src/lib/backend-client', () => {
  const actual = jest.requireActual('../src/lib/backend-client');
  return { ...actual, backendRequest: (...args: unknown[]) => mockBackendRequest(...args) };
});

import { ICAL_URL_REDACTED, scrubSecrets } from '../src/tools/secrets';
import { fail, ok, type ToolContext } from '../src/tools/registry';
import { createListing, duplicateListing, listMyListings, setListingPublished, updateListing } from '../src/tools/defs/vendor';
import { applyDynamicPricing, updateRateRule } from '../src/tools/defs/pricing-rules';
import { logUnitMaintenance, updateFleetUnit } from '../src/tools/defs/fleet';
import { getListingDetails } from '../src/tools/defs/discovery';

const FEED = 'https://calendar.example/ical/secret-token-123.ics';
const ID = '00000000-0000-4000-8000-000000000001';
const vendor: ToolContext = { userId: 'v', role: 'vendor_owner', token: 'header.payload.sig', kind: 'oauth' };
const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content[0].text ?? '';
const listing = { id: 'l-1', name: 'Kayak', icalUrl: FEED, pricePerDay: '65.00' };

describe('scrubSecrets', () => {
  it('replaces a secret field at any depth, in objects and arrays', () => {
    expect(scrubSecrets({ icalUrl: FEED, id: 'l-1' })).toEqual({ icalUrl: ICAL_URL_REDACTED, id: 'l-1' });
    expect(scrubSecrets({ unit: { listing: { icalUrl: FEED } }, record: { id: 'm-1' } })).toEqual({ unit: { listing: { icalUrl: ICAL_URL_REDACTED } }, record: { id: 'm-1' } });
    expect(scrubSecrets([{ icalUrl: FEED }, [{ icalUrl: FEED }]])).toEqual([{ icalUrl: ICAL_URL_REDACTED }, [{ icalUrl: ICAL_URL_REDACTED }]]);
  });

  it('leaves a secret field out when it holds nothing', () => {
    expect(scrubSecrets({ id: 'l-1', icalUrl: null })).toEqual({ id: 'l-1' });
    expect(scrubSecrets({ id: 'l-1', icalUrl: '' })).toEqual({ id: 'l-1' });
  });

  it('keeps everything else, including falsy values, Dates and prototype-named keys, and never mutates its input', () => {
    const when = new Date('2026-09-27T00:00:00Z');
    const input = { icalUrl: FEED, open: false, count: 0, at: when, constructor: 'x', toString: 'y', nested: { hasOwnProperty: 1 } };
    const out = scrubSecrets(input) as Record<string, unknown>;
    expect(out).toEqual({ icalUrl: ICAL_URL_REDACTED, open: false, count: 0, at: when, constructor: 'x', toString: 'y', nested: { hasOwnProperty: 1 } });
    expect(out.at).toBe(when);
    expect(input.icalUrl).toBe(FEED);
    expect(scrubSecrets('icalUrl')).toBe('icalUrl');
    expect(scrubSecrets(null)).toBeNull();
  });
});

describe('no tool result carries a listing iCal URL', () => {
  beforeEach(() => mockBackendRequest.mockReset());

  it('ok() and fail() details scrub what they serialize', () => {
    expect(text(ok({ listing }))).not.toContain('secret-token-123');
    expect(text(fail('Conflict', { listing }))).not.toContain('secret-token-123');
  });

  // Each backend answer below is the shape the backend returns for that route (read from its services 2026-09-27).
  const cases: Array<[string, unknown, () => Promise<{ content: Array<{ type: string; text?: string }> }>]> = [
    ['list_my_listings', [listing], () => listMyListings.handler({}, vendor)],
    ['get_listing_details', listing, () => getListingDetails.handler({ listingId: ID }, vendor)],
    ['create_listing', listing, () => createListing.handler({ name: 'Kayak', description: 'A stable touring kayak for lakes.', pricePerDay: 65 }, vendor)],
    ['update_listing', listing, () => updateListing.handler({ listingId: ID, pricePerDay: 70 }, vendor)],
    ['set_listing_published', listing, () => setListingPublished.handler({ listingId: ID, published: true }, vendor)],
    ['duplicate_listing', listing, () => duplicateListing.handler({ listingId: ID }, vendor)],
    ['apply_dynamic_pricing', { success: true, listing }, () => applyDynamicPricing.handler({ listingId: ID }, vendor)],
    ['apply_dynamic_pricing (bulk)', { success: true, applied: 1, listing }, () => applyDynamicPricing.handler({ listingId: ID, bulk: true }, vendor)],
    ['update_rate_rule', { id: 'r-1', name: 'Summer', listing }, () => updateRateRule.handler({ ruleId: ID, name: 'Summer peak' }, vendor)],
    ['update_fleet_unit', { id: 'u-1', status: 'maintenance', listing }, () => updateFleetUnit.handler({ unitId: ID, status: 'maintenance' }, vendor)],
    ['log_unit_maintenance', { unit: { id: 'u-1', listing }, record: { id: 'm-1' } }, () => logUnitMaintenance.handler({ unitId: ID, kind: 'service', description: 'Replaced the seat.' }, vendor)],
  ];
  it.each(cases)('%s', async (_name, reply, run) => {
    mockBackendRequest.mockResolvedValue(reply);
    const out = text(await run());
    expect(out).not.toContain('secret-token-123');
    expect(out).toContain(ICAL_URL_REDACTED);
  });
});
