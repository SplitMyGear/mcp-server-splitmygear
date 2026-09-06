/** Contract tests for the disputes / claims / incidental-charges backend module and its tool defs. */
export {};

const mockBackendRequest = jest.fn();
jest.mock('../src/lib/backend-client', () => {
  class BackendApiError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.name = 'BackendApiError'; this.status = status; }
  }
  return { BackendApiError, backendRequest: (...args: unknown[]) => mockBackendRequest(...args), backendBaseUrl: () => 'https://api.test/api/v1' };
});

import { trustApi } from '../src/tools/trust';
import {
  trustTools,
  openDispute,
  listClaims,
  fileDamageClaim,
  respondToClaim,
  addClaimEvidence,
  listIncidentalCharges,
  fileIncidentalCharge,
  respondToIncidentalCharge,
  cancelIncidentalCharge,
} from '../src/tools/defs/trust';

const T = 'h.p.s';
const B = '11111111-1111-4111-8111-111111111111';
const C = '22222222-2222-4222-8222-222222222222';
const EVIDENCE = 'https://x.private.blob.vercel-storage.com/claims/a.png';
const { BackendApiError } = jest.requireMock('../src/lib/backend-client');

function lastCall() {
  const c = mockBackendRequest.mock.calls[mockBackendRequest.mock.calls.length - 1];
  return { method: c[0], path: c[1], opts: c[2] ?? {} };
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[0]?.text ?? '';
}

beforeEach(() => {
  mockBackendRequest.mockReset();
  mockBackendRequest.mockResolvedValue({ ok: 1 });
});

describe('trustApi: disputes', () => {
  it('lists, reads and opens disputes with only DTO fields', async () => {
    await trustApi.listDisputes(T);
    expect(lastCall()).toEqual({ method: 'GET', path: '/disputes', opts: { token: T } });
    await trustApi.getDispute(T, 'd1');
    expect(lastCall()).toEqual({ method: 'GET', path: '/disputes/d1', opts: { token: T } });
    await trustApi.openDispute(T, { bookingId: B, reason: 'Gear arrived broken', evidenceUrls: [EVIDENCE] });
    expect(lastCall()).toEqual({ method: 'POST', path: '/disputes', opts: { token: T, body: { bookingId: B, reason: 'Gear arrived broken', evidenceUrls: [EVIDENCE] } } });
    await trustApi.openDispute(T, { bookingId: B, reason: 'No evidence', evidenceUrls: [] });
    expect(lastCall().opts.body).toEqual({ bookingId: B, reason: 'No evidence' });
  });
});

describe('trustApi: damage claims', () => {
  it('lists with state + pagination, reads, files, responds and adds evidence', async () => {
    await trustApi.listClaims(T);
    expect(lastCall()).toEqual({ method: 'GET', path: '/claims', opts: { token: T } });
    await trustApi.listClaims(T, { state: 'submitted', limit: 10, offset: 20 });
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/claims?state=submitted&limit=10&offset=20', opts: { token: T } });
    await trustApi.getClaim(T, C);
    expect(lastCall()).toEqual({ method: 'GET', path: `/claims/${C}`, opts: { token: T } });

    await trustApi.fileClaim(T, {
      bookingId: B,
      description: 'Cracked frame',
      claimedAmount: 120.5,
      evidence: [{ type: 'photo', fileUrl: EVIDENCE, text: undefined, bookingVerificationId: undefined }, { type: 'statement', text: 'Noticed at return' }],
    });
    expect(lastCall()).toEqual({
      method: 'POST',
      path: '/claims',
      opts: { token: T, body: { bookingId: B, description: 'Cracked frame', claimedAmount: 120.5, evidence: [{ type: 'photo', fileUrl: EVIDENCE }, { type: 'statement', text: 'Noticed at return' }] } },
    });
    expect(lastCall().opts.body.evidence[0]).not.toHaveProperty('internalOnly');

    await trustApi.respondToClaim(T, C, { response: 'disputed', evidence: [{ type: 'receipt_pdf', fileUrl: EVIDENCE }] });
    expect(lastCall()).toEqual({ method: 'POST', path: `/claims/${C}/respond`, opts: { token: T, body: { response: 'disputed', evidence: [{ type: 'receipt_pdf', fileUrl: EVIDENCE }] } } });
    await trustApi.respondToClaim(T, C, { response: 'accepted' });
    expect(lastCall().opts.body).toEqual({ response: 'accepted' });
    await trustApi.respondToClaim(T, C, { response: 'accepted', evidence: [] });
    expect(lastCall().opts.body).toEqual({ response: 'accepted' });

    await trustApi.addClaimEvidence(T, C, { type: 'statement', text: 'It was fine at pickup', fileUrl: undefined });
    expect(lastCall()).toEqual({ method: 'POST', path: `/claims/${C}/evidence`, opts: { token: T, body: { type: 'statement', text: 'It was fine at pickup' } } });
  });
});

describe('trustApi: incidental charges', () => {
  it('lists with filters, reads, files, responds and cancels', async () => {
    await trustApi.listIncidentalCharges(T);
    expect(lastCall()).toEqual({ method: 'GET', path: '/incidental-charges', opts: { token: T } });
    await trustApi.listIncidentalCharges(T, { status: 'pending_review', bookingId: B, limit: 5, offset: 0 });
    expect(lastCall().path).toBe(`/incidental-charges?status=pending_review&bookingId=${B}&limit=5&offset=0`);
    await trustApi.getIncidentalCharge(T, C);
    expect(lastCall()).toEqual({ method: 'GET', path: `/incidental-charges/${C}`, opts: { token: T } });

    await trustApi.fileIncidentalCharge(T, { bookingId: B, type: 'fuel', amount: 45, description: 'Returned on empty', evidence: undefined });
    expect(lastCall()).toEqual({ method: 'POST', path: '/incidental-charges', opts: { token: T, body: { bookingId: B, type: 'fuel', amount: 45, description: 'Returned on empty' } } });
    await trustApi.fileIncidentalCharge(T, { bookingId: B, type: 'damage', amount: 80, description: 'Torn seat', evidence: [{ url: EVIDENCE, caption: undefined }, { url: EVIDENCE, caption: 'close-up' }] });
    expect(lastCall().opts.body.evidence).toEqual([{ url: EVIDENCE }, { url: EVIDENCE, caption: 'close-up' }]);

    await trustApi.respondToIncidentalCharge(T, C, { action: 'dispute', note: 'Tank was half full' });
    expect(lastCall()).toEqual({ method: 'POST', path: `/incidental-charges/${C}/respond`, opts: { token: T, body: { action: 'dispute', note: 'Tank was half full' } } });
    await trustApi.respondToIncidentalCharge(T, C, { action: 'accept', note: undefined });
    expect(lastCall().opts.body).toEqual({ action: 'accept' });

    await trustApi.cancelIncidentalCharge(T, C);
    expect(lastCall()).toEqual({ method: 'POST', path: `/incidental-charges/${C}/cancel`, opts: { token: T, body: {} } });
  });

  it('returns an error Result (not a throw) when the backend rejects', async () => {
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(403, 'Only the renter on this booking may respond to the charge'));
    expect(await trustApi.respondToIncidentalCharge(T, C, { action: 'accept' })).toEqual({ ok: false, error: 'Only the renter on this booking may respond to the charge', status: 403 });
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(409, 'A claim already exists for this booking'));
    expect(await trustApi.fileClaim(T, { bookingId: B, description: 'd', claimedAmount: 1, evidence: [{ type: 'photo', fileUrl: EVIDENCE }] })).toEqual({ ok: false, error: 'A claim already exists for this booking', status: 409 });
    mockBackendRequest.mockRejectedValueOnce(new Error('boom'));
    expect(await trustApi.listDisputes(T)).toEqual({ ok: false, error: 'Unexpected error talking to Splitt' });
  });
});

describe('trustTools defs', () => {
  it('exports every tool with access, scope, description and annotations', () => {
    expect(trustTools.map((t) => t.name)).toEqual([
      'list_disputes',
      'get_dispute',
      'open_dispute',
      'list_claims',
      'get_claim',
      'file_damage_claim',
      'respond_to_claim',
      'add_claim_evidence',
      'list_incidental_charges',
      'get_incidental_charge',
      'file_incidental_charge',
      'respond_to_incidental_charge',
      'cancel_incidental_charge',
    ]);
    for (const def of trustTools) {
      expect(['user', 'vendor']).toContain(def.access);
      expect(def.scope).toBe('claims');
      expect(def.description.length).toBeGreaterThanOrEqual(40);
      expect(def.description).not.toMatch(/—/);
      expect(def.title.split(' ').length).toBeLessThanOrEqual(5);
      expect(typeof def.handler).toBe('function');
      expect(def.annotations).toHaveProperty('readOnlyHint');
    }
    const byName = Object.fromEntries(trustTools.map((t) => [t.name, t]));
    // Vendor-only filings mirror the backend @Roles(VENDOR) gates; renter responses are party-checked (any user).
    expect(byName.file_damage_claim.access).toBe('vendor');
    expect(byName.file_incidental_charge.access).toBe('vendor');
    expect(byName.cancel_incidental_charge.access).toBe('vendor');
    expect(byName.respond_to_claim.access).toBe('user');
    expect(byName.respond_to_incidental_charge.access).toBe('user');
    expect(byName.open_dispute.access).toBe('user');
    // Money-moving / irreversible actions are flagged destructive; reads are read-only.
    for (const name of ['open_dispute', 'file_damage_claim', 'respond_to_claim', 'file_incidental_charge', 'respond_to_incidental_charge', 'cancel_incidental_charge']) {
      expect(byName[name].annotations.destructiveHint).toBe(true);
      expect(byName[name].description).toMatch(/confirm/i);
    }
    for (const name of ['list_disputes', 'get_dispute', 'list_claims', 'get_claim', 'list_incidental_charges', 'get_incidental_charge']) {
      expect(byName[name].annotations.readOnlyHint).toBe(true);
    }
    expect(byName.add_claim_evidence.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it('validates claim evidence before calling the backend', async () => {
    const ctx = { token: T, role: 'vendor' };
    const noProof = await fileDamageClaim.handler({ bookingId: B, description: 'Cracked frame on return', claimedAmount: 50, evidence: [{ type: 'statement', text: 'It broke' }] }, ctx);
    expect(noProof.isError).toBe(true);
    expect(text(noProof)).toMatch(/photo or receipt_pdf/);
    const noUrl = await fileDamageClaim.handler({ bookingId: B, description: 'Cracked frame on return', claimedAmount: 50, evidence: [{ type: 'photo' }] }, ctx);
    expect(text(noUrl)).toMatch(/needs a fileUrl/);
    const emptyStatement = await respondToClaim.handler({ claimId: C, response: 'disputed', evidence: [{ type: 'statement', text: '  ' }] }, { token: T });
    expect(text(emptyStatement)).toMatch(/statement evidence item needs text/);
    expect(mockBackendRequest).not.toHaveBeenCalled();

    await fileDamageClaim.handler({ bookingId: B, description: 'Cracked frame on return', claimedAmount: 50, evidence: [{ type: 'photo', fileUrl: EVIDENCE }] }, ctx);
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/claims', opts: { token: T, body: { bookingId: B, claimedAmount: 50, evidence: [{ type: 'photo', fileUrl: EVIDENCE }] } } });
    await respondToClaim.handler({ claimId: C, response: 'accepted' }, { token: T });
    expect(lastCall()).toMatchObject({ method: 'POST', path: `/claims/${C}/respond`, opts: { body: { response: 'accepted' } } });
    await addClaimEvidence.handler({ claimId: C, type: 'receipt_pdf', fileUrl: EVIDENCE, text: 'Repair invoice' }, { token: T });
    expect(lastCall()).toMatchObject({ method: 'POST', path: `/claims/${C}/evidence`, opts: { body: { type: 'receipt_pdf', fileUrl: EVIDENCE, text: 'Repair invoice' } } });
    const badItem = await addClaimEvidence.handler({ claimId: C, type: 'photo' }, { token: T });
    expect(badItem.isError).toBe(true);
  });

  it('validates incidental charges and surfaces the hosted invoice next step', async () => {
    const vendor = { token: T, role: 'vendor_owner' };
    const noEvidence = await fileIncidentalCharge.handler({ bookingId: B, type: 'damage', amount: 80, description: 'Torn seat cover needs replacement' }, vendor);
    expect(noEvidence.isError).toBe(true);
    expect(text(noEvidence)).toMatch(/damage charge needs at least one evidence item/);
    const noNote = await respondToIncidentalCharge.handler({ chargeId: C, action: 'dispute', note: '' }, { token: T });
    expect(noNote.isError).toBe(true);
    expect(mockBackendRequest).not.toHaveBeenCalled();

    await fileIncidentalCharge.handler({ bookingId: B, type: 'fuel', amount: 45, description: 'Returned with an empty tank' }, vendor);
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/incidental-charges', opts: { token: T, body: { bookingId: B, type: 'fuel', amount: 45 } } });
    expect(lastCall().opts.body).not.toHaveProperty('evidence');

    mockBackendRequest.mockResolvedValueOnce({ id: C, status: 'awaiting_payment', hostedInvoiceUrl: 'https://invoice.stripe.com/i/x' });
    const accepted = await respondToIncidentalCharge.handler({ chargeId: C, action: 'accept' }, { token: T });
    expect(lastCall()).toMatchObject({ method: 'POST', path: `/incidental-charges/${C}/respond`, opts: { body: { action: 'accept' } } });
    const payload = JSON.parse(text(accepted));
    expect(payload.charge.hostedInvoiceUrl).toBe('https://invoice.stripe.com/i/x');
    expect(payload.nextStep).toMatch(/hostedInvoiceUrl/);

    mockBackendRequest.mockResolvedValueOnce({ id: C, status: 'captured' });
    const captured = await respondToIncidentalCharge.handler({ chargeId: C, action: 'accept' }, { token: T });
    expect(JSON.parse(text(captured))).toEqual({ id: C, status: 'captured' });

    await cancelIncidentalCharge.handler({ chargeId: C }, vendor);
    expect(lastCall()).toMatchObject({ method: 'POST', path: `/incidental-charges/${C}/cancel`, opts: { token: T } });
  });

  it('passes list filters through and maps backend errors with status hints', async () => {
    await listClaims.handler({ state: 'admin_review', limit: 25, offset: 50 }, { token: T });
    expect(lastCall().path).toBe('/claims?state=admin_review&limit=25&offset=50');
    await listIncidentalCharges.handler({ status: 'disputed', bookingId: B }, { token: T });
    expect(lastCall().path).toBe(`/incidental-charges?status=disputed&bookingId=${B}`);
    await openDispute.handler({ bookingId: B, reason: 'The kayak leaked badly', evidenceUrls: [EVIDENCE] }, { token: T });
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/disputes', opts: { body: { bookingId: B, reason: 'The kayak leaked badly', evidenceUrls: [EVIDENCE] } } });

    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(403, 'You do not own the listing for this booking'));
    const denied = await fileIncidentalCharge.handler({ bookingId: B, type: 'cleaning', amount: 30, description: 'Mud everywhere inside the tent' }, { token: T, role: 'vendor' });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toBe('Not allowed for this account: You do not own the listing for this booking');
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(409, 'A claim already exists for this booking'));
    const conflict = await fileDamageClaim.handler({ bookingId: B, description: 'Cracked frame on return', claimedAmount: 50, evidence: [{ type: 'photo', fileUrl: EVIDENCE }] }, { token: T, role: 'vendor' });
    expect(text(conflict)).toMatch(/^Conflict: /);
  });
});
