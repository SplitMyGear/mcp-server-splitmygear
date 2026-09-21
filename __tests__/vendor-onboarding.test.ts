/** Contract tests for the become-a-vendor onboarding tools: exact backend method/path/body/token per call, plus the tool defs. */
export {};

const mockBackendRequest = jest.fn();
jest.mock('../src/lib/backend-client', () => {
  class BackendApiError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.name = 'BackendApiError'; this.status = status; }
  }
  return { BackendApiError, backendRequest: (...args: unknown[]) => mockBackendRequest(...args) };
});

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { vendorOnboardingApi, onboardingNextStep, VENDOR_ONBOARDING_STATUSES } from '../src/tools/vendor-onboarding';
import {
  vendorOnboardingTools,
  applyToBecomeVendor,
  startVendorOnboarding,
  completeVendorBusinessProfile,
  startVendorStripeOnboarding,
  checkVendorStripeStatus,
  confirmVendorStripe,
  getVendorAgreement,
  signVendorAgreement,
} from '../src/tools/defs/vendor-onboarding';
import { TOOL_SCOPES, type ToolContext } from '../src/tools/registry';

const T = 'h.p.s';
const ctx: ToolContext = { userId: 'u1', role: 'renter', token: T, kind: 'oauth' };
const WAIVER_ID = '11111111-1111-4111-8111-111111111111';
const { BackendApiError } = jest.requireMock('../src/lib/backend-client');

function lastCall() {
  const c = mockBackendRequest.mock.calls[mockBackendRequest.mock.calls.length - 1];
  return { method: c[0], path: c[1], opts: c[2] ?? {} };
}

function parse(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (first.type !== 'text') throw new Error('expected text content');
  return JSON.parse(first.text);
}

function text(result: CallToolResult): string {
  const first = result.content[0];
  return first.type === 'text' ? first.text : '';
}

beforeEach(() => {
  mockBackendRequest.mockReset();
  mockBackendRequest.mockResolvedValue({ status: 'profile_pending' });
});

describe('vendorOnboardingApi', () => {
  it('files an application with ONLY the application fields and the caller token', async () => {
    await vendorOnboardingApi.apply(T, { businessName: 'Peak Rentals', businessInterest: 'Skis and boards', inviteToken: undefined });
    expect(lastCall()).toMatchObject({
      method: 'POST',
      path: '/vendor-onboarding/apply',
      opts: { token: T, body: { businessName: 'Peak Rentals', businessInterest: 'Skis and boards' } },
    });
    const body = lastCall().opts.body;
    expect(body).not.toHaveProperty('inviteToken');
    for (const forbidden of ['email', 'password', 'firstName', 'lastName', 'website']) expect(body).not.toHaveProperty(forbidden);
    await vendorOnboardingApi.apply(T, { inviteToken: 'inv.tok' });
    expect(lastCall().opts.body).toEqual({ inviteToken: 'inv.tok' });
    await vendorOnboardingApi.apply(T, {});
    expect(lastCall().opts.body).toEqual({});
  });

  it('starts onboarding', async () => {
    await vendorOnboardingApi.start(T);
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/vendor-onboarding/start', opts: { token: T, body: {} } });
  });

  it('completes the business profile with the four DTO fields', async () => {
    const input = { storeName: 'Peak', businessPhone: '+1 555 0100', businessAddress: '1 Main St, Denver, CO', storeDescription: 'Skis, boards and boots for every level of rider.' };
    await vendorOnboardingApi.completeProfile(T, input);
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/vendor-onboarding/profile', opts: { token: T, body: input } });
    expect(Object.keys(lastCall().opts.body).sort()).toEqual(['businessAddress', 'businessPhone', 'storeDescription', 'storeName']);
  });

  it('runs the in-pipeline Stripe Connect routes', async () => {
    await vendorOnboardingApi.startStripeConnect(T);
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/vendor-onboarding/stripe/connect', opts: { token: T, body: {} } });
    await vendorOnboardingApi.getStripeStatus(T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/vendor-onboarding/stripe/status', opts: { token: T } });
    expect(lastCall().opts.body).toBeUndefined();
    await vendorOnboardingApi.confirmStripe(T);
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/vendor-onboarding/confirm-stripe', opts: { token: T, body: {} } });
  });

  it('reads and signs the vendor agreement', async () => {
    await vendorOnboardingApi.getWaiver(T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/vendor-onboarding/waiver', opts: { token: T } });
    await vendorOnboardingApi.signWaiver(T, { signature: 'Ada Lovelace', waiverId: WAIVER_ID, waiverVersion: 3 });
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/vendor-onboarding/waiver', opts: { token: T, body: { signature: 'Ada Lovelace', waiverId: WAIVER_ID, waiverVersion: 3 } } });
    await vendorOnboardingApi.signWaiver(T, { signature: 'Ada Lovelace', waiverId: undefined, waiverVersion: undefined });
    expect(lastCall().opts.body).toEqual({ signature: 'Ada Lovelace' });
  });

  it('returns a Result error (not a throw) when the backend refuses', async () => {
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(403, 'No active onboarding application. Start onboarding first.'));
    expect(await vendorOnboardingApi.completeProfile(T, { storeName: 'a', businessPhone: 'b', businessAddress: 'c', storeDescription: 'd'.repeat(20) })).toEqual({
      ok: false,
      error: 'No active onboarding application. Start onboarding first.',
      status: 403,
    });
    mockBackendRequest.mockRejectedValueOnce(new Error('socket hang up'));
    expect((await vendorOnboardingApi.start(T)).ok).toBe(false);
  });
});

describe('onboardingNextStep', () => {
  it('names the next tool for every backend status and has a fallback', () => {
    const expectations: Record<(typeof VENDOR_ONBOARDING_STATUSES)[number], RegExp> = {
      not_started: /apply_to_become_vendor|start_vendor_onboarding/,
      applied: /admit/,
      profile_pending: /complete_vendor_business_profile/,
      stripe_pending: /start_vendor_stripe_onboarding.*confirm_vendor_stripe/,
      waiver_pending: /get_vendor_agreement.*sign_vendor_agreement/,
      admin_review: /reviewing/,
      active: /active/,
      rejected: /start_vendor_onboarding/,
    };
    for (const status of VENDOR_ONBOARDING_STATUSES) expect(onboardingNextStep(status)).toMatch(expectations[status]);
    expect(onboardingNextStep(undefined)).toMatch(/get_vendor_onboarding_status/);
    expect(onboardingNextStep('weird')).toMatch(/get_vendor_onboarding_status/);
  });
});

describe('vendorOnboardingTools defs', () => {
  it('exports eight user/profile tools with model-facing docs and unique names', () => {
    expect(vendorOnboardingTools).toHaveLength(8);
    const names = vendorOnboardingTools.map((t) => t.name);
    expect(names).toEqual([
      'apply_to_become_vendor',
      'start_vendor_onboarding',
      'complete_vendor_business_profile',
      'start_vendor_stripe_onboarding',
      'check_vendor_stripe_status',
      'confirm_vendor_stripe',
      'get_vendor_agreement',
      'sign_vendor_agreement',
    ]);
    expect(new Set(names).size).toBe(names.length);
    for (const t of vendorOnboardingTools) {
      expect(t.access).toBe('user');
      expect(t.scope).toBe('profile');
      expect(TOOL_SCOPES).toContain(t.scope);
      expect(t.name).toMatch(/^[a-z][a-z0-9_]+$/);
      expect(t.title.split(/\s+/).length).toBeGreaterThanOrEqual(2);
      expect(t.title.split(/\s+/).length).toBeLessThanOrEqual(4);
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.description).not.toMatch(/—/);
      expect(t.annotations).toHaveProperty('readOnlyHint');
      expect(typeof t.handler).toBe('function');
    }
    for (const t of [checkVendorStripeStatus, getVendorAgreement]) expect(t.annotations.readOnlyHint).toBe(true);
    for (const t of [applyToBecomeVendor, startVendorOnboarding, completeVendorBusinessProfile, startVendorStripeOnboarding, confirmVendorStripe, signVendorAgreement]) {
      expect(t.annotations.readOnlyHint).toBe(false);
      expect(t.annotations.destructiveHint).toBe(false);
    }
    expect(applyToBecomeVendor.annotations.idempotentHint).toBe(false);
    expect(signVendorAgreement.description).toMatch(/LEGALLY BINDING/);
    expect(startVendorStripeOnboarding.description).toMatch(/never collect/);
  });

  it('apply: forwards only the given fields and reports admission + next step', async () => {
    mockBackendRequest.mockResolvedValueOnce({ status: 'applied', admitted: false, user: { id: 'u1', vendorOnboardingStatus: 'applied' } });
    const res = await applyToBecomeVendor.handler({ businessInterest: 'Kayaks' }, ctx);
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/vendor-onboarding/apply', opts: { token: T, body: { businessInterest: 'Kayaks' } } });
    expect(parse(res)).toMatchObject({ status: 'applied', admitted: false, user: { id: 'u1' } });
    expect(String(parse(res).nextStep)).toMatch(/admit/);
    mockBackendRequest.mockResolvedValueOnce({ status: 'profile_pending', admitted: true });
    expect(String(parse(await applyToBecomeVendor.handler({ inviteToken: 'inv' }, ctx)).nextStep)).toMatch(/complete_vendor_business_profile/);
  });

  it('start / confirm: return the status view with a next step and surface backend refusals', async () => {
    mockBackendRequest.mockResolvedValueOnce({ status: 'profile_pending', steps: [], readyForReview: false });
    expect(parse(await startVendorOnboarding.handler({}, ctx))).toMatchObject({ status: 'profile_pending', readyForReview: false });
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/vendor-onboarding/start', opts: { token: T } });
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(400, 'User is already a vendor'));
    const refused = await startVendorOnboarding.handler({}, ctx);
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/already a vendor/);
    mockBackendRequest.mockResolvedValueOnce({ status: 'waiver_pending' });
    const confirmed = parse(await confirmVendorStripe.handler({}, ctx));
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/vendor-onboarding/confirm-stripe' });
    expect(String(confirmed.nextStep)).toMatch(/get_vendor_agreement/);
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(400, 'Your Stripe payout account is not yet enabled.'));
    expect(text(await confirmVendorStripe.handler({}, ctx))).toMatch(/not yet enabled/);
  });

  it('profile: trims, rejects blanks locally, and sends the four DTO fields', async () => {
    const blank = await completeVendorBusinessProfile.handler({ storeName: '   ', businessPhone: '1', businessAddress: 'a', storeDescription: 'x'.repeat(20) }, ctx);
    expect(blank.isError).toBe(true);
    expect(mockBackendRequest).not.toHaveBeenCalled();
    const short = await completeVendorBusinessProfile.handler({ storeName: 'Peak', businessPhone: '1', businessAddress: 'a', storeDescription: `${'x'.repeat(19)}      ` }, ctx);
    expect(short.isError).toBe(true);
    expect(mockBackendRequest).not.toHaveBeenCalled();
    mockBackendRequest.mockResolvedValueOnce({ status: 'stripe_pending' });
    const res = await completeVendorBusinessProfile.handler(
      { storeName: ' Peak ', businessPhone: ' +1 555 0100 ', businessAddress: ' 1 Main St ', storeDescription: ' Skis, boards and boots for everyone. ' },
      ctx,
    );
    expect(lastCall()).toMatchObject({
      method: 'POST',
      path: '/vendor-onboarding/profile',
      opts: { token: T, body: { storeName: 'Peak', businessPhone: '+1 555 0100', businessAddress: '1 Main St', storeDescription: 'Skis, boards and boots for everyone.' } },
    });
    expect(String(parse(res).nextStep)).toMatch(/start_vendor_stripe_onboarding/);
  });

  it('stripe: returns the hosted URL to hand to the user and a status-aware next step', async () => {
    mockBackendRequest.mockResolvedValueOnce({ url: 'https://connect.stripe.com/setup/x', accountId: 'acct_1' });
    const link = parse(await startVendorStripeOnboarding.handler({}, ctx));
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/vendor-onboarding/stripe/connect', opts: { token: T } });
    expect(link).toMatchObject({ onboardingUrl: 'https://connect.stripe.com/setup/x', accountId: 'acct_1' });
    expect(String(link.nextStep)).toMatch(/check_vendor_stripe_status/);
    mockBackendRequest.mockResolvedValueOnce({ connected: true, status: 'enabled', chargesEnabled: true, payoutsEnabled: true });
    const enabled = parse(await checkVendorStripeStatus.handler({}, ctx));
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/vendor-onboarding/stripe/status', opts: { token: T } });
    expect(enabled).toMatchObject({ connected: true, status: 'enabled' });
    expect(String(enabled.nextStep)).toMatch(/confirm_vendor_stripe/);
    mockBackendRequest.mockResolvedValueOnce({ connected: false, status: 'not_connected' });
    expect(String(parse(await checkVendorStripeStatus.handler({}, ctx)).nextStep)).toMatch(/start_vendor_stripe_onboarding/);
    mockBackendRequest.mockResolvedValueOnce({ connected: true, status: 'pending' });
    expect(String(parse(await checkVendorStripeStatus.handler({}, ctx)).nextStep)).toMatch(/check again/);
  });

  it('agreement: exposes the terms with id/version, or available=false when none is configured', async () => {
    mockBackendRequest.mockResolvedValueOnce({ id: WAIVER_ID, name: 'Vendor Agreement', content: '<p>Terms</p>', version: 4 });
    const res = parse(await getVendorAgreement.handler({}, ctx));
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/vendor-onboarding/waiver', opts: { token: T } });
    expect(res).toMatchObject({ available: true, waiverId: WAIVER_ID, waiverVersion: 4, name: 'Vendor Agreement', content: '<p>Terms</p>' });
    expect(String(res.nextStep)).toMatch(/sign_vendor_agreement/);
    mockBackendRequest.mockResolvedValueOnce(null);
    expect(parse(await getVendorAgreement.handler({}, ctx))).toMatchObject({ available: false });
    mockBackendRequest.mockResolvedValueOnce({ id: WAIVER_ID, name: 'x', content: '   ', version: 1 });
    expect(parse(await getVendorAgreement.handler({}, ctx))).toMatchObject({ available: false });
  });

  it('sign: trims the typed name, binds id/version, refuses a blank signature, and relays a 409', async () => {
    const blank = await signVendorAgreement.handler({ signature: '   ' }, ctx);
    expect(blank.isError).toBe(true);
    expect(mockBackendRequest).not.toHaveBeenCalled();
    mockBackendRequest.mockResolvedValueOnce({ status: 'admin_review', readyForReview: true });
    const res = parse(await signVendorAgreement.handler({ signature: ' Ada Lovelace ', waiverId: WAIVER_ID, waiverVersion: 4 }, ctx));
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/vendor-onboarding/waiver', opts: { token: T, body: { signature: 'Ada Lovelace', waiverId: WAIVER_ID, waiverVersion: 4 } } });
    expect(res).toMatchObject({ signed: true, status: 'admin_review', readyForReview: true });
    expect(String(res.nextStep)).toMatch(/reviewing/);
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(409, 'The vendor agreement was updated. Please review the current version before signing.'));
    const conflict = await signVendorAgreement.handler({ signature: 'Ada Lovelace', waiverId: WAIVER_ID, waiverVersion: 3 }, ctx);
    expect(conflict.isError).toBe(true);
    expect(text(conflict)).toMatch(/Conflict: The vendor agreement was updated/);
  });
});
