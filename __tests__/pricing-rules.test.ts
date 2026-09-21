/** Contract tests for the vendor pricing backends (rate rules + dynamic pricing): exact method/path/body/token per call, plus the tool defs. */
export {};

const mockBackendRequest = jest.fn();
jest.mock('../src/lib/backend-client', () => {
  class BackendApiError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.name = 'BackendApiError'; this.status = status; }
  }
  return { BackendApiError, backendRequest: (...args: unknown[]) => mockBackendRequest(...args) };
});

import type { ZodTypeAny } from 'zod';
import { pricingRulesApi } from '../src/tools/pricing-rules';
import {
  pricingRulesTools,
  createRateRule,
  updateRateRule,
  deleteRateRule,
  applyStarterSeasons,
  setDynamicPricingConfig,
  previewDynamicPrice,
  getDynamicPricingRecommendations,
  applyDynamicPricing,
  getMarketInsights,
} from '../src/tools/defs/pricing-rules';
import { TOOL_SCOPES } from '../src/tools/registry';

const T = 'h.p.s';
const L = '11111111-1111-4111-8111-111111111111';
const R = '22222222-2222-4222-8222-222222222222';
const ctx = { token: T, role: 'vendor', userId: 'u1' };
const { BackendApiError } = jest.requireMock('../src/lib/backend-client');

function lastCall() {
  const c = mockBackendRequest.mock.calls[mockBackendRequest.mock.calls.length - 1];
  return { method: c[0], path: c[1], opts: c[2] ?? {} };
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

beforeEach(() => {
  mockBackendRequest.mockReset();
  mockBackendRequest.mockResolvedValue({ ok: 1 });
});

describe('pricingRulesApi: seasonal rate rules', () => {
  it('lists, creates, updates, deletes and applies starter seasons on the canonical /rentals routes', async () => {
    await pricingRulesApi.listRateRules(T, L);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/rentals/${L}/rate-rules`, opts: { token: T } });
    expect(lastCall().opts.body).toBeUndefined();

    await pricingRulesApi.createRateRule(T, L, { name: 'Summer peak', startDate: '2026-06-15', endDate: '2026-09-01', ratePct: 25, minNights: 2, nightlyRate: undefined, weekdayMask: undefined });
    expect(lastCall()).toMatchObject({
      method: 'POST',
      path: `/rentals/${L}/rate-rules`,
      opts: { token: T, body: { name: 'Summer peak', startDate: '2026-06-15', endDate: '2026-09-01', ratePct: 25, minNights: 2 } },
    });
    expect(lastCall().opts.body).not.toHaveProperty('nightlyRate');
    expect(lastCall().opts.body).not.toHaveProperty('weekdayMask');

    // null is a legitimate PATCH value (clears the field) and must survive compact().
    await pricingRulesApi.updateRateRule(T, R, { nightlyRate: 195.5, ratePct: null, weekdayMask: [5, 6], name: undefined });
    expect(lastCall()).toMatchObject({ method: 'PATCH', path: `/rentals/rate-rules/${R}`, opts: { token: T, body: { nightlyRate: 195.5, ratePct: null, weekdayMask: [5, 6] } } });
    expect(lastCall().opts.body).not.toHaveProperty('name');

    mockBackendRequest.mockResolvedValueOnce(undefined); // 204 No Content
    expect(await pricingRulesApi.deleteRateRule(T, R)).toEqual({ ok: true, data: undefined });
    expect(lastCall()).toMatchObject({ method: 'DELETE', path: `/rentals/rate-rules/${R}`, opts: { token: T } });

    await pricingRulesApi.applyStarterSeasons(T, L, { year: 2027, replaceExisting: true });
    expect(lastCall()).toMatchObject({ method: 'POST', path: `/rentals/${L}/rate-rules/starter-seasons`, opts: { token: T, body: { year: 2027, replaceExisting: true } } });
    await pricingRulesApi.applyStarterSeasons(T, L, { year: 2027 });
    expect(lastCall().opts.body).toEqual({ year: 2027 });
  });

  it('surfaces backend errors as a Result (403 for a vendor_staff seat, 400 for an hourly listing)', async () => {
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(403, 'Insufficient vendor permissions'));
    expect(await pricingRulesApi.createRateRule(T, L, { name: 'x', startDate: '2026-06-15', endDate: '2026-06-16', ratePct: 10 })).toEqual({
      ok: false,
      error: 'Insufficient vendor permissions',
      status: 403,
    });
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(400, 'Seasonal rate rules apply to nightly (stay) listings only'));
    const res = await pricingRulesApi.listRateRules(T, L);
    expect(res).toMatchObject({ ok: false, status: 400 });
    mockBackendRequest.mockRejectedValueOnce(new Error('boom'));
    expect(await pricingRulesApi.deleteRateRule(T, R)).toEqual({ ok: false, error: 'Unexpected error talking to Splitt' });
  });
});

describe('pricingRulesApi: dynamic pricing', () => {
  it('reads and writes the config with only the given fields', async () => {
    await pricingRulesApi.getDynamicPricingConfig(T, L);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/dynamic-pricing/config/${L}`, opts: { token: T } });
    await pricingRulesApi.setDynamicPricingConfig(T, L, { enabled: true, minPrice: 40, adjustmentSensitivity: 'high', maxPrice: undefined });
    expect(lastCall()).toMatchObject({ method: 'PUT', path: `/dynamic-pricing/config/${L}`, opts: { token: T, body: { enabled: true, minPrice: 40, adjustmentSensitivity: 'high' } } });
    expect(lastCall().opts.body).not.toHaveProperty('maxPrice');
  });

  it('calculates single-date and range prices via query strings', async () => {
    await pricingRulesApi.calculatePrice(T, L);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/dynamic-pricing/calculate/${L}`, opts: { token: T } });
    await pricingRulesApi.calculatePrice(T, L, { date: '2026-07-04', days: 3 });
    expect(lastCall().path).toBe(`/dynamic-pricing/calculate/${L}?date=2026-07-04&days=3`);
    await pricingRulesApi.calculatePriceRange(T, L, '2026-07-01', '2026-07-10');
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/dynamic-pricing/calculate/range/${L}?startDate=2026-07-01&endDate=2026-07-10`, opts: { token: T } });
  });

  it('reads, generates and applies recommendations', async () => {
    await pricingRulesApi.getRecommendations(T, L);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/dynamic-pricing/recommendations/${L}`, opts: { token: T } });
    await pricingRulesApi.getRecommendations(T, L, '2026-07-01', undefined);
    expect(lastCall().path).toBe(`/dynamic-pricing/recommendations/${L}?startDate=2026-07-01`);
    await pricingRulesApi.generateRecommendations(T, L, 14);
    expect(lastCall()).toMatchObject({ method: 'POST', path: `/dynamic-pricing/recommendations/${L}`, opts: { token: T, body: { days: 14 } } });
    await pricingRulesApi.generateRecommendations(T, L);
    expect(lastCall().opts.body).toEqual({});
    await pricingRulesApi.applySuggestedPrice(T, L, '2026-07-04');
    expect(lastCall()).toMatchObject({ method: 'POST', path: `/dynamic-pricing/apply/${L}`, opts: { token: T, body: { date: '2026-07-04' } } });
    await pricingRulesApi.applySuggestedPrice(T, L);
    expect(lastCall().opts.body).toEqual({});
    await pricingRulesApi.applySuggestedPricesBulk(T, L);
    expect(lastCall()).toMatchObject({ method: 'POST', path: `/dynamic-pricing/apply-bulk/${L}`, opts: { token: T, body: {} } });
  });

  it('reads the suggested initial price and market insights (category URL-encoded)', async () => {
    await pricingRulesApi.getSuggestedInitialPrice(T, L);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/dynamic-pricing/suggested-price/${L}`, opts: { token: T } });
    await pricingRulesApi.getMarketInsights(T, 'Water Sports');
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/dynamic-pricing/market-insights/Water%20Sports', opts: { token: T } });
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(404, 'No market data found for category: Other'));
    expect(await pricingRulesApi.getMarketInsights(T, 'Other')).toEqual({ ok: false, error: 'No market data found for category: Other', status: 404 });
  });
});

describe('pricingRulesTools defs', () => {
  const EM_DASH = '—';

  it('exports vendor/listings tools with complete, em-dash-free metadata and unique names', () => {
    expect(pricingRulesTools.length).toBeGreaterThanOrEqual(12);
    const names = pricingRulesTools.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    for (const def of pricingRulesTools) {
      expect(def.name).toMatch(/^[a-z][a-z0-9_]+$/);
      expect(def.title.split(/\s+/).length).toBeLessThanOrEqual(4);
      expect(def.description.length).toBeGreaterThanOrEqual(40);
      expect(def.access).toBe('vendor');
      expect(def.scope).toBe('listings');
      expect(TOOL_SCOPES).toContain(def.scope);
      expect(def.annotations).toHaveProperty('readOnlyHint');
      expect(def.description).not.toContain(EM_DASH);
      expect(def.title).not.toContain(EM_DASH);
      for (const schema of Object.values(def.inputSchema) as ZodTypeAny[]) {
        expect(schema.description ?? '').not.toContain(EM_DASH);
      }
    }
  });

  it('marks reads read-only and deletes/price overwrites destructive', () => {
    const byName = Object.fromEntries(pricingRulesTools.map((d) => [d.name, d]));
    for (const n of ['list_rate_rules', 'get_dynamic_pricing_config', 'preview_dynamic_price', 'get_dynamic_pricing_recommendations', 'get_suggested_initial_price', 'get_market_insights']) {
      expect(byName[n].annotations.readOnlyHint).toBe(true);
    }
    for (const n of ['delete_rate_rule', 'apply_dynamic_pricing']) {
      expect(byName[n].annotations.destructiveHint).toBe(true);
    }
    for (const n of ['create_rate_rule', 'update_rate_rule', 'apply_starter_seasons', 'set_dynamic_pricing_config', 'generate_dynamic_pricing_recommendations']) {
      expect(byName[n].annotations.readOnlyHint).toBe(false);
      expect(byName[n].annotations.destructiveHint).toBe(false);
    }
    // Pricing mutations tell the model about the vendor_staff 403 up front.
    for (const n of ['create_rate_rule', 'update_rate_rule', 'delete_rate_rule', 'apply_starter_seasons', 'set_dynamic_pricing_config', 'generate_dynamic_pricing_recommendations', 'apply_dynamic_pricing']) {
      expect(byName[n].description).toMatch(/vendor_staff/);
    }
  });

  it('create_rate_rule validates the range and the rate XOR before calling Splitt', async () => {
    let res = await createRateRule.handler({ listingId: L, name: 'Peak', startDate: '2026-09-01', endDate: '2026-06-15' }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/endDate must be after startDate/);
    res = await createRateRule.handler({ listingId: L, name: 'Peak', startDate: '2026-06-15', endDate: '2026-09-01', nightlyRate: 200, ratePct: 20 }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/mutually exclusive/);
    expect(mockBackendRequest).not.toHaveBeenCalled();
    res = await createRateRule.handler({ listingId: L, name: 'Peak', startDate: '2026-06-15', endDate: '2026-09-01', ratePct: 20, weekdayMask: [5, 6] }, ctx);
    expect(res.isError).toBeUndefined();
    expect(lastCall()).toMatchObject({ method: 'POST', path: `/rentals/${L}/rate-rules`, opts: { token: T, body: { name: 'Peak', startDate: '2026-06-15', endDate: '2026-09-01', ratePct: 20, weekdayMask: [5, 6] } } });
    expect(lastCall().opts.body).not.toHaveProperty('listingId');
  });

  it('update_rate_rule requires a field, forwards null clears, and delete maps 204 to a receipt', async () => {
    let res = await updateRateRule.handler({ ruleId: R }, ctx);
    expect(res.isError).toBe(true);
    res = await updateRateRule.handler({ ruleId: R, startDate: 'not-a-date' }, ctx);
    expect(text(res)).toMatch(/Invalid startDate/);
    res = await updateRateRule.handler({ ruleId: R, nightlyRate: 150, ratePct: null, minNights: null }, ctx);
    expect(res.isError).toBeUndefined();
    expect(lastCall()).toMatchObject({ method: 'PATCH', path: `/rentals/rate-rules/${R}`, opts: { body: { nightlyRate: 150, ratePct: null, minNights: null } } });
    mockBackendRequest.mockResolvedValueOnce(undefined);
    res = await deleteRateRule.handler({ ruleId: R }, ctx);
    expect(JSON.parse(text(res))).toEqual({ deleted: true, ruleId: R });
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(403, 'Insufficient vendor permissions'));
    res = await deleteRateRule.handler({ ruleId: R }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Not allowed for this account/);
  });

  it('apply_starter_seasons rejects years outside the backend window', async () => {
    const year = new Date().getUTCFullYear();
    let res = await applyStarterSeasons.handler({ listingId: L, year: year - 1 }, ctx);
    expect(res.isError).toBe(true);
    res = await applyStarterSeasons.handler({ listingId: L, year: year + 4 }, ctx);
    expect(res.isError).toBe(true);
    expect(mockBackendRequest).not.toHaveBeenCalled();
    res = await applyStarterSeasons.handler({ listingId: L, year: year + 1, replaceExisting: true }, ctx);
    expect(res.isError).toBeUndefined();
    expect(lastCall()).toMatchObject({ method: 'POST', path: `/rentals/${L}/rate-rules/starter-seasons`, opts: { token: T, body: { year: year + 1, replaceExisting: true } } });
  });

  it('set_dynamic_pricing_config needs a field and a sane min/max', async () => {
    let res = await setDynamicPricingConfig.handler({ listingId: L }, ctx);
    expect(res.isError).toBe(true);
    res = await setDynamicPricingConfig.handler({ listingId: L, minPrice: 100, maxPrice: 50 }, ctx);
    expect(text(res)).toMatch(/minPrice must not exceed maxPrice/);
    res = await setDynamicPricingConfig.handler({ listingId: L, enabled: true, maxDailyAdjustment: 0.1 }, ctx);
    expect(res.isError).toBeUndefined();
    expect(lastCall()).toMatchObject({ method: 'PUT', path: `/dynamic-pricing/config/${L}`, opts: { body: { enabled: true, maxDailyAdjustment: 0.1 } } });
    expect(lastCall().opts.body).not.toHaveProperty('listingId');
  });

  it('preview_dynamic_price routes single-date vs range calls', async () => {
    let res = await previewDynamicPrice.handler({ listingId: L }, ctx);
    expect(res.isError).toBeUndefined();
    expect(lastCall().path).toBe(`/dynamic-pricing/calculate/${L}`);
    res = await previewDynamicPrice.handler({ listingId: L, date: '2026-07-04', days: 2 }, ctx);
    expect(lastCall().path).toBe(`/dynamic-pricing/calculate/${L}?date=2026-07-04&days=2`);
    res = await previewDynamicPrice.handler({ listingId: L, endDate: '2026-07-10' }, ctx);
    expect(text(res)).toMatch(/Pass date/);
    res = await previewDynamicPrice.handler({ listingId: L, date: '2026-07-01', endDate: '2026-07-10', days: 3 }, ctx);
    expect(text(res)).toMatch(/days applies to single-date/);
    res = await previewDynamicPrice.handler({ listingId: L, date: '2026-07-10', endDate: '2026-07-01' }, ctx);
    expect(text(res)).toMatch(/endDate must be after startDate/);
    res = await previewDynamicPrice.handler({ listingId: L, date: '2026-07-01', endDate: '2026-07-10' }, ctx);
    expect(res.isError).toBeUndefined();
    expect(lastCall().path).toBe(`/dynamic-pricing/calculate/range/${L}?startDate=2026-07-01&endDate=2026-07-10`);
  });

  it('get_dynamic_pricing_recommendations validates dates; apply_dynamic_pricing switches on bulk', async () => {
    let res = await getDynamicPricingRecommendations.handler({ listingId: L, startDate: '2026-07-10', endDate: '2026-07-01' }, ctx);
    expect(res.isError).toBe(true);
    res = await getDynamicPricingRecommendations.handler({ listingId: L, endDate: 'nope' }, ctx);
    expect(text(res)).toMatch(/Invalid endDate/);
    res = await getDynamicPricingRecommendations.handler({ listingId: L, startDate: '2026-07-01', endDate: '2026-07-31' }, ctx);
    expect(res.isError).toBeUndefined();
    expect(lastCall().path).toBe(`/dynamic-pricing/recommendations/${L}?startDate=2026-07-01&endDate=2026-07-31`);

    res = await applyDynamicPricing.handler({ listingId: L, bulk: true, date: '2026-07-04' }, ctx);
    expect(text(res)).toMatch(/date applies to single-date apply only/);
    res = await applyDynamicPricing.handler({ listingId: L, bulk: true }, ctx);
    expect(lastCall()).toMatchObject({ method: 'POST', path: `/dynamic-pricing/apply-bulk/${L}`, opts: { token: T, body: {} } });
    res = await applyDynamicPricing.handler({ listingId: L, date: '2026-07-04' }, ctx);
    expect(lastCall()).toMatchObject({ method: 'POST', path: `/dynamic-pricing/apply/${L}`, opts: { token: T, body: { date: '2026-07-04' } } });
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(400, 'Dynamic pricing is not enabled for this listing'));
    res = await applyDynamicPricing.handler({ listingId: L }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/not enabled/);
  });

  it('get_market_insights forwards the enum category with the vendor token', async () => {
    const res = await getMarketInsights.handler({ category: 'Camping' }, ctx);
    expect(res.isError).toBeUndefined();
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/dynamic-pricing/market-insights/Camping', opts: { token: T } });
  });
});
