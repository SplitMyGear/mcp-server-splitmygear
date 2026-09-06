/** Contract tests for the vendor extras backends (settings, money details, promotions, transactions, trust): exact method/path/body/token per call, plus the tool defs. */
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
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { vendorExtrasApi, REPORT_FREQUENCIES, REPORT_TYPES, SPONSOR_TIERS } from '../src/tools/vendor-extras';
import {
  vendorExtrasTools,
  setAutoApprove,
  setReportSubscription,
  getTaxSummary,
  getPayoutDetails,
  requestPayout,
  promoteListing,
  getBookingRisk,
  getTransaction,
  refreshMyTrustScore,
} from '../src/tools/defs/vendor-extras';
import { TOOL_SCOPES, type ToolContext } from '../src/tools/registry';

const T = 'h.p.s';
const L = '11111111-1111-4111-8111-111111111111';
const P = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';
const X = '44444444-4444-4444-8444-444444444444';
const ctx: ToolContext = { userId: 'u1', role: 'vendor_owner', token: T, kind: 'oauth' };
const { BackendApiError } = jest.requireMock('../src/lib/backend-client');

function lastCall() {
  const c = mockBackendRequest.mock.calls[mockBackendRequest.mock.calls.length - 1];
  return { method: c[0], path: c[1], opts: c[2] ?? {} };
}

function text(result: CallToolResult): string {
  const first = result.content[0];
  return first.type === 'text' ? first.text : '';
}

function parse(result: CallToolResult): Record<string, unknown> {
  return JSON.parse(text(result));
}

beforeEach(() => {
  mockBackendRequest.mockReset();
  mockBackendRequest.mockResolvedValue({ success: true });
});

describe('vendorExtrasApi: vendor settings', () => {
  it('toggles auto-approve with a strict boolean body', async () => {
    await vendorExtrasApi.setAutoApprove(T, true);
    expect(lastCall()).toMatchObject({ method: 'PATCH', path: '/vendor/auto-approve', opts: { token: T, body: { enabled: true } } });
    await vendorExtrasApi.setAutoApprove(T, false);
    expect(lastCall().opts.body).toEqual({ enabled: false });
  });

  it('reads and updates the report subscription with only the given DTO fields', async () => {
    await vendorExtrasApi.getReportSubscription(T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/vendor/report-subscription', opts: { token: T } });
    expect(lastCall().opts.body).toBeUndefined();

    await vendorExtrasApi.updateReportSubscription(T, { frequency: 'weekly', subscribedTypes: undefined });
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/vendor/report-subscription', opts: { token: T, body: { frequency: 'weekly' } } });
    expect(lastCall().opts.body).not.toHaveProperty('subscribedTypes');

    await vendorExtrasApi.updateReportSubscription(T, { subscribedTypes: ['revenue', 'payouts'] });
    expect(lastCall().opts.body).toEqual({ subscribedTypes: ['revenue', 'payouts'] });
  });
});

describe('vendorExtrasApi: money details', () => {
  it('builds the tax-summary query string from year / format', async () => {
    await vendorExtrasApi.getTaxSummary(T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/vendor/tax-summary', opts: { token: T } });
    await vendorExtrasApi.getTaxSummary(T, { year: 2025 });
    expect(lastCall().path).toBe('/vendor/tax-summary?year=2025');
    await vendorExtrasApi.getTaxSummary(T, { year: 2025, format: 'csv' });
    expect(lastCall().path).toBe('/vendor/tax-summary?year=2025&format=csv');
  });

  it('reads payout details and the statement on the owner/manager routes', async () => {
    await vendorExtrasApi.getPayoutDetails(T, P);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/vendor/payouts/${P}`, opts: { token: T } });
    await vendorExtrasApi.getPayoutStatement(T, P);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/vendor/payouts/${P}/statement`, opts: { token: T } });
  });

  it('merges payout details with the statement and reports a statement failure without failing the read', async () => {
    mockBackendRequest.mockImplementation(async (_m: string, path: string) => {
      if (path === `/vendor/payouts/${P}`) return { success: true, payout: { id: P, status: 'completed' } };
      if (path === `/vendor/payouts/${P}/statement`) return { success: true, statement: { payoutId: P, bookings: [] } };
      throw new Error(`unexpected ${path}`);
    });
    expect(await vendorExtrasApi.getPayoutWithStatement(T, P)).toEqual({
      ok: true,
      data: { payout: { success: true, payout: { id: P, status: 'completed' } }, statement: { success: true, statement: { payoutId: P, bookings: [] } }, errors: [] },
    });
    const paths = mockBackendRequest.mock.calls.map((c) => c[1]).sort();
    expect(paths).toEqual([`/vendor/payouts/${P}`, `/vendor/payouts/${P}/statement`]);
    for (const c of mockBackendRequest.mock.calls) expect(c[2]).toMatchObject({ token: T });

    mockBackendRequest.mockImplementation(async (_m: string, path: string) => {
      if (path === `/vendor/payouts/${P}`) return { payout: { id: P } };
      throw new BackendApiError(500, 'statement unavailable');
    });
    const partial = await vendorExtrasApi.getPayoutWithStatement(T, P);
    expect(partial).toEqual({ ok: true, data: { payout: { payout: { id: P } }, statement: null, errors: ['statement: statement unavailable'] } });

    mockBackendRequest.mockRejectedValue(new BackendApiError(404, 'Payout not found'));
    expect(await vendorExtrasApi.getPayoutWithStatement(T, P)).toEqual({ ok: false, error: 'Payout not found', status: 404 });
  });

  it('requests a payout with only the RequestPayoutDto fields', async () => {
    await vendorExtrasApi.requestPayout(T);
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/vendor/payouts', opts: { token: T, body: {} } });
    await vendorExtrasApi.requestPayout(T, { amount: 125.5, description: undefined });
    expect(lastCall().opts.body).toEqual({ amount: 125.5 });
    await vendorExtrasApi.requestPayout(T, { amount: 50, description: 'July' });
    expect(lastCall().opts.body).toEqual({ amount: 50, description: 'July' });
  });

  it('surfaces backend errors as a Result (403 for a manager seat, 400 for an over-drawn amount, network failure)', async () => {
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(403, 'Insufficient vendor permissions'));
    expect(await vendorExtrasApi.requestPayout(T, { amount: 10 })).toEqual({ ok: false, error: 'Insufficient vendor permissions', status: 403 });
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(400, 'Insufficient withdrawable balance'));
    expect(await vendorExtrasApi.requestPayout(T, { amount: 10_000 })).toMatchObject({ ok: false, status: 400 });
    mockBackendRequest.mockRejectedValueOnce(new Error('boom'));
    expect(await vendorExtrasApi.getTaxSummary(T)).toEqual({ ok: false, error: 'Unexpected error talking to Splitt' });
  });
});

describe('vendorExtrasApi: sponsored listings', () => {
  it('lists packages and promotions, and opens promotion checkout with ONLY the tier', async () => {
    await vendorExtrasApi.listSponsorshipPackages(T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/payments/sponsorship-packages', opts: { token: T } });
    await vendorExtrasApi.listListingPromotions(T, L);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/payments/listings/${L}/promotions`, opts: { token: T } });
    await vendorExtrasApi.promoteListing(T, L, 'FEATURED');
    expect(lastCall()).toMatchObject({ method: 'POST', path: `/payments/listings/${L}/promote`, opts: { token: T, body: { tier: 'FEATURED' } } });
    expect(lastCall().opts.body).not.toHaveProperty('successUrl');
    expect(lastCall().opts.body).not.toHaveProperty('cancelUrl');
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(503, 'Payments are not configured'));
    expect(await vendorExtrasApi.promoteListing(T, L, 'STARTER')).toEqual({ ok: false, error: 'Payments are not configured', status: 503 });
  });
});

describe('vendorExtrasApi: transactions and trust', () => {
  it('reads the transaction list and one transaction', async () => {
    await vendorExtrasApi.listTransactions(T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/payments/transactions', opts: { token: T } });
    await vendorExtrasApi.getTransaction(T, X);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/payments/transactions/${X}`, opts: { token: T } });
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(403, 'Unauthorized'));
    expect(await vendorExtrasApi.getTransaction(T, X)).toEqual({ ok: false, error: 'Unauthorized', status: 403 });
  });

  it('reads, refreshes and assesses trust', async () => {
    await vendorExtrasApi.getMyTrustScore(T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/trust/my-score', opts: { token: T } });
    await vendorExtrasApi.refreshMyTrustScore(T);
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/trust/refresh-score', opts: { token: T, body: {} } });
    await vendorExtrasApi.getBookingRisk(T, B);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/trust/booking/${B}/risk`, opts: { token: T } });
  });
});

describe('vendorExtrasTools defs', () => {
  const EM_DASH = '—';
  const byName = Object.fromEntries(vendorExtrasTools.map((d) => [d.name, d]));

  it('exports every tool with complete, em-dash-free metadata and unique names', () => {
    expect(vendorExtrasTools).toHaveLength(14);
    const names = vendorExtrasTools.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    for (const def of vendorExtrasTools) {
      expect(def.name).toMatch(/^[a-z][a-z0-9_]+$/);
      expect(def.title.split(/\s+/).length).toBeLessThanOrEqual(4);
      expect(def.description.length).toBeGreaterThanOrEqual(40);
      expect(['public', 'user', 'renter', 'vendor', 'vendor_finance', 'vendor_owner']).toContain(def.access);
      expect(TOOL_SCOPES).toContain(def.scope);
      expect(def.annotations).toHaveProperty('readOnlyHint');
      expect(def.description).not.toContain(EM_DASH);
      expect(def.title).not.toContain(EM_DASH);
      for (const schema of Object.values(def.inputSchema) as ZodTypeAny[]) {
        expect(schema.description ?? '').not.toContain(EM_DASH);
      }
    }
  });

  it('mirrors the backend guards in access and the fixed scope taxonomy', () => {
    const expected: Record<string, [string, string]> = {
      set_auto_approve: ['vendor', 'vendor_bookings'],
      get_report_subscription: ['vendor', 'finance'],
      set_report_subscription: ['vendor', 'finance'],
      get_tax_summary: ['vendor', 'finance'],
      get_payout_details: ['vendor_finance', 'finance'],
      request_payout: ['vendor_owner', 'finance'],
      list_sponsorship_packages: ['vendor', 'finance'],
      list_listing_promotions: ['vendor', 'finance'],
      promote_listing: ['vendor', 'finance'],
      list_my_transactions: ['user', 'finance'],
      get_transaction: ['user', 'finance'],
      get_my_trust_score: ['user', 'profile'],
      refresh_my_trust_score: ['user', 'profile'],
      get_booking_risk: ['vendor', 'vendor_bookings'],
    };
    expect(Object.keys(byName).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, [access, scope]] of Object.entries(expected)) {
      expect(byName[name].access).toBe(access);
      expect(byName[name].scope).toBe(scope);
    }
  });

  it('marks reads read-only, the payout request destructive, and settings idempotent', () => {
    for (const n of ['get_report_subscription', 'get_tax_summary', 'get_payout_details', 'list_sponsorship_packages', 'list_listing_promotions', 'list_my_transactions', 'get_transaction', 'get_my_trust_score', 'get_booking_risk']) {
      expect(byName[n].annotations.readOnlyHint).toBe(true);
    }
    expect(byName.request_payout.annotations.destructiveHint).toBe(true);
    expect(byName.request_payout.description).toMatch(/confirmation/);
    for (const n of ['set_auto_approve', 'set_report_subscription', 'refresh_my_trust_score']) {
      expect(byName[n].annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    }
    expect(byName.promote_listing.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.promote_listing.description).toMatch(/Stripe/);
    // Fixed enums come straight from the backend entities.
    expect(REPORT_FREQUENCIES).toEqual(['daily', 'weekly', 'monthly', 'quarterly', 'annual', 'none']);
    expect(REPORT_TYPES).toEqual(['revenue', 'bookings', 'payouts', 'listings', 'all']);
    expect(SPONSOR_TIERS).toEqual(['STARTER', 'FEATURED', 'PREMIUM']);
  });

  it('set_auto_approve forwards the boolean with the caller token', async () => {
    mockBackendRequest.mockResolvedValueOnce({ success: true, autoApproveBookings: true, listingsUpdated: 3 });
    const res = await setAutoApprove.handler({ enabled: true }, ctx);
    expect(res.isError).toBeUndefined();
    expect(parse(res)).toMatchObject({ autoApproveBookings: true, listingsUpdated: 3 });
    expect(lastCall()).toMatchObject({ method: 'PATCH', path: '/vendor/auto-approve', opts: { token: T, body: { enabled: true } } });
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(403, 'Insufficient role permissions'));
    const denied = await setAutoApprove.handler({ enabled: false }, ctx);
    expect(denied.isError).toBe(true);
    expect(text(denied)).toMatch(/Not allowed for this account/);
  });

  it('set_report_subscription needs at least one field and sends only what was passed', async () => {
    let res = await setReportSubscription.handler({}, ctx);
    expect(res.isError).toBe(true);
    expect(mockBackendRequest).not.toHaveBeenCalled();
    res = await setReportSubscription.handler({ frequency: 'none' }, ctx);
    expect(res.isError).toBeUndefined();
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/vendor/report-subscription', opts: { token: T, body: { frequency: 'none' } } });
    expect(lastCall().opts.body).not.toHaveProperty('subscribedTypes');
    res = await setReportSubscription.handler({ subscribedTypes: ['all'] }, ctx);
    expect(lastCall().opts.body).toEqual({ subscribedTypes: ['all'] });
  });

  it('get_tax_summary rejects years past the backend window and maps format csv to the query', async () => {
    const nextYear = new Date().getFullYear() + 1;
    let res = await getTaxSummary.handler({ year: nextYear + 1 }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(String(nextYear));
    expect(mockBackendRequest).not.toHaveBeenCalled();
    res = await getTaxSummary.handler({}, ctx);
    expect(res.isError).toBeUndefined();
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/vendor/tax-summary', opts: { token: T } });
    res = await getTaxSummary.handler({ year: 2025, format: 'json' }, ctx);
    expect(lastCall().path).toBe('/vendor/tax-summary?year=2025');
    res = await getTaxSummary.handler({ year: 2025, format: 'csv' }, ctx);
    expect(lastCall().path).toBe('/vendor/tax-summary?year=2025&format=csv');
  });

  it('get_payout_details fetches the statement by default and skips it on request', async () => {
    mockBackendRequest.mockImplementation(async (_m: string, path: string) => {
      if (path === `/vendor/payouts/${P}`) return { success: true, payout: { id: P } };
      if (path === `/vendor/payouts/${P}/statement`) return { success: true, statement: { totals: { net: 90 } } };
      throw new Error(`unexpected ${path}`);
    });
    let res = await getPayoutDetails.handler({ payoutId: P }, ctx);
    expect(res.isError).toBeUndefined();
    expect(parse(res)).toEqual({ payout: { success: true, payout: { id: P } }, statement: { success: true, statement: { totals: { net: 90 } } }, errors: [] });
    expect(mockBackendRequest).toHaveBeenCalledTimes(2);

    mockBackendRequest.mockClear();
    res = await getPayoutDetails.handler({ payoutId: P, includeStatement: false }, ctx);
    expect(mockBackendRequest).toHaveBeenCalledTimes(1);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/vendor/payouts/${P}`, opts: { token: T } });
    expect(parse(res)).toEqual({ success: true, payout: { id: P } });

    mockBackendRequest.mockRejectedValue(new BackendApiError(404, 'Payout not found'));
    res = await getPayoutDetails.handler({ payoutId: P }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Not found: Payout not found/);
  });

  it('request_payout sends only the DTO fields and surfaces balance errors', async () => {
    mockBackendRequest.mockResolvedValueOnce({ success: true, payout: { id: P, amount: 100, netAmount: 100, status: 'completed' } });
    let res = await requestPayout.handler({}, ctx);
    expect(res.isError).toBeUndefined();
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/vendor/payouts', opts: { token: T, body: {} } });
    res = await requestPayout.handler({ amount: 42.5, description: 'Weekly' }, ctx);
    expect(lastCall().opts.body).toEqual({ amount: 42.5, description: 'Weekly' });
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(400, 'Insufficient withdrawable balance'));
    res = await requestPayout.handler({ amount: 9_999 }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Insufficient withdrawable balance/);
  });

  it('promote_listing returns the Stripe checkout link with a next step', async () => {
    mockBackendRequest.mockResolvedValueOnce({ success: true, sessionId: 'cs_1', checkoutUrl: 'https://checkout.stripe.com/p' });
    const res = await promoteListing.handler({ listingId: L, tier: 'PREMIUM' }, ctx);
    expect(res.isError).toBeUndefined();
    expect(parse(res)).toMatchObject({ checkoutUrl: 'https://checkout.stripe.com/p', sessionId: 'cs_1', tier: 'PREMIUM', listingId: L });
    expect(String(parse(res).nextStep)).toMatch(/checkoutUrl/);
    expect(lastCall()).toMatchObject({ method: 'POST', path: `/payments/listings/${L}/promote`, opts: { token: T, body: { tier: 'PREMIUM' } } });
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(403, 'You can only promote your own listings'));
    const denied = await promoteListing.handler({ listingId: L, tier: 'STARTER' }, ctx);
    expect(denied.isError).toBe(true);
    expect(text(denied)).toMatch(/only promote your own/);
  });

  it('transaction, trust and risk handlers forward the caller token to the exact routes', async () => {
    let res = await getTransaction.handler({ transactionId: X }, ctx);
    expect(res.isError).toBeUndefined();
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/payments/transactions/${X}`, opts: { token: T } });
    mockBackendRequest.mockResolvedValueOnce({ score: 72, message: 'Trust score updated' });
    res = await refreshMyTrustScore.handler({}, ctx);
    expect(parse(res)).toEqual({ score: 72, message: 'Trust score updated' });
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/trust/refresh-score', opts: { token: T, body: {} } });
    mockBackendRequest.mockResolvedValueOnce({ riskLevel: 'low', flags: [], recommendation: 'Approve' });
    res = await getBookingRisk.handler({ bookingId: B }, ctx);
    expect(parse(res)).toMatchObject({ riskLevel: 'low' });
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/trust/booking/${B}/risk`, opts: { token: T } });
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(403, 'Not a party to this booking'));
    res = await getBookingRisk.handler({ bookingId: B }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Not allowed for this account/);
  });
});
