/** Contract tests for the compliance backends (insurance policies + waivers): exact method/path/body/token per call, and the tool defs. */
export {};
import type { ZodRawShape } from 'zod';
import type { ToolDef, ToolContext } from '../src/tools/registry';

const mockBackendRequest = jest.fn();
jest.mock('../src/lib/backend-client', () => {
  class BackendApiError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.name = 'BackendApiError'; this.status = status; }
  }
  return { BackendApiError, backendRequest: (...args: unknown[]) => mockBackendRequest(...args) };
});

import { complianceApi, INSURANCE_COVERAGE_TYPES, WAIVER_KINDS } from '../src/tools/compliance';
import { complianceTools } from '../src/tools/defs/compliance';
import { TOOL_SCOPES } from '../src/tools/registry';

const T = 'h.p.s';
const POLICY = '11111111-1111-4111-8111-111111111111';
const WAIVER = '22222222-2222-4222-8222-222222222222';
const LISTING = '33333333-3333-4333-8333-333333333333';
const BOOKING = '44444444-4444-4444-8444-444444444444';
const { BackendApiError } = jest.requireMock('../src/lib/backend-client');

const vendorCtx: ToolContext = { userId: 'u', role: 'vendor', token: T, kind: 'oauth' };
const renterCtx: ToolContext = { userId: 'u', role: 'renter', token: T, kind: 'oauth' };

function lastCall() {
  const c = mockBackendRequest.mock.calls[mockBackendRequest.mock.calls.length - 1];
  return { method: c[0], path: c[1], opts: c[2] ?? {} };
}

const defs = complianceTools as unknown as ToolDef<ZodRawShape>[];
function tool(name: string): ToolDef<ZodRawShape> {
  const t = defs.find((d) => d.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}
function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

beforeEach(() => {
  mockBackendRequest.mockReset();
  mockBackendRequest.mockResolvedValue({ ok: 1 });
});

describe('complianceApi: insurance policies', () => {
  it('lists, creates, updates, deletes and resolves the document url with the vendor token', async () => {
    await complianceApi.listMyInsurancePolicies(T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/insurance-policies/mine', opts: { token: T } });
    expect(lastCall().opts.body).toBeUndefined();

    await complianceApi.addInsurancePolicy(T, {
      carrier: 'Acme Mutual',
      policyNumber: 'GL-123',
      coverageType: 'general_liability',
      perOccurrenceLimit: 1_000_000,
      aggregateLimit: undefined,
      effectiveDate: '2026-01-01',
      expiryDate: '2027-01-01',
      documentUrl: undefined,
    });
    expect(lastCall()).toMatchObject({
      method: 'POST',
      path: '/insurance-policies',
      opts: { token: T, body: { carrier: 'Acme Mutual', policyNumber: 'GL-123', coverageType: 'general_liability', perOccurrenceLimit: 1_000_000, effectiveDate: '2026-01-01', expiryDate: '2027-01-01' } },
    });
    expect(lastCall().opts.body).not.toHaveProperty('aggregateLimit');
    expect(lastCall().opts.body).not.toHaveProperty('documentUrl');

    await complianceApi.updateInsurancePolicy(T, POLICY, { documentUrl: 'https://x.private.blob.vercel-storage.com/insurance/a.pdf', carrier: undefined });
    expect(lastCall()).toMatchObject({ method: 'PUT', path: `/insurance-policies/${POLICY}`, opts: { token: T, body: { documentUrl: 'https://x.private.blob.vercel-storage.com/insurance/a.pdf' } } });
    expect(Object.keys(lastCall().opts.body)).toEqual(['documentUrl']);

    await complianceApi.deleteInsurancePolicy(T, POLICY);
    expect(lastCall()).toMatchObject({ method: 'DELETE', path: `/insurance-policies/${POLICY}`, opts: { token: T } });

    await complianceApi.getInsuranceDocumentUrl(T, POLICY);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/insurance-policies/${POLICY}/document-url`, opts: { token: T } });
  });

  it('returns a structured error Result instead of throwing', async () => {
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(409, 'Only a pending or rejected policy can be deleted'));
    expect(await complianceApi.deleteInsurancePolicy(T, POLICY)).toEqual({ ok: false, error: 'Only a pending or rejected policy can be deleted', status: 409 });
    mockBackendRequest.mockRejectedValueOnce(new Error('socket hang up'));
    expect(await complianceApi.listMyInsurancePolicies(T)).toEqual({ ok: false, error: 'Unexpected error talking to Splitt' });
  });
});

describe('complianceApi: vendor waivers', () => {
  it('maps CRUD onto /vendors/waivers and sends only DTO fields', async () => {
    await complianceApi.listMyWaivers(T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/vendors/waivers', opts: { token: T } });

    await complianceApi.createWaiver(T, { name: 'Liability', content: '<p>You assume all risk.</p>', description: undefined, minAge: 18 });
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/vendors/waivers', opts: { token: T, body: { name: 'Liability', content: '<p>You assume all risk.</p>', minAge: 18 } } });
    expect(lastCall().opts.body).not.toHaveProperty('description');

    await complianceApi.updateWaiver(T, WAIVER, { minAge: null, isActive: false });
    expect(lastCall()).toMatchObject({ method: 'PUT', path: `/vendors/waivers/${WAIVER}`, opts: { token: T, body: { minAge: null, isActive: false } } });

    await complianceApi.deleteWaiver(T, WAIVER);
    expect(lastCall()).toMatchObject({ method: 'DELETE', path: `/vendors/waivers/${WAIVER}`, opts: { token: T } });
  });
});

describe('complianceApi: waiver signing', () => {
  it('reads required + signed waivers and signs platform or vendor waivers', async () => {
    await complianceApi.getRequiredWaivers(T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/waivers/required', opts: { token: T } });
    await complianceApi.getRequiredWaivers(T, LISTING);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/waivers/listing/${LISTING}`, opts: { token: T } });
    await complianceApi.listSignedWaivers(T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/waivers/agreements', opts: { token: T } });

    await complianceApi.signWaiver(T, 'platform', WAIVER, { signature: 'Jane Q Renter', bookingId: undefined });
    expect(lastCall()).toMatchObject({ method: 'POST', path: `/waivers/${WAIVER}/agree`, opts: { token: T, body: { signature: 'Jane Q Renter' } } });
    expect(lastCall().opts.body).not.toHaveProperty('bookingId');

    await complianceApi.signWaiver(T, 'vendor', WAIVER, { signature: 'Jane Q Renter', bookingId: BOOKING });
    expect(lastCall()).toMatchObject({ method: 'POST', path: `/waivers/vendor/${WAIVER}/agree`, opts: { token: T, body: { signature: 'Jane Q Renter', bookingId: BOOKING } } });
  });
});

describe('complianceTools defs', () => {
  it('exports well-formed tools with the right access levels and scopes', () => {
    expect(defs.map((t) => t.name)).toEqual([
      'list_my_insurance_policies',
      'add_insurance_policy',
      'update_insurance_policy',
      'delete_insurance_policy',
      'get_insurance_document_link',
      'list_my_waivers',
      'create_waiver',
      'update_waiver',
      'delete_waiver',
      'get_required_waivers',
      'list_signed_waivers',
      'sign_waiver',
    ]);
    expect(new Set(defs.map((t) => t.name)).size).toBe(defs.length);
    for (const t of defs) {
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect(t.title.length).toBeGreaterThan(2);
      expect(t.description.length).toBeGreaterThanOrEqual(40);
      expect(t.description).not.toMatch(/—/);
      expect(['public', 'user', 'renter', 'vendor', 'vendor_finance', 'vendor_owner']).toContain(t.access);
      expect(TOOL_SCOPES).toContain(t.scope);
      expect(t.annotations).toHaveProperty('readOnlyHint');
      expect(typeof t.handler).toBe('function');
      for (const schema of Object.values(t.inputSchema)) {
        expect(schema.description ?? '').not.toMatch(/—/);
      }
    }
    const vendorSide = ['list_my_insurance_policies', 'add_insurance_policy', 'update_insurance_policy', 'delete_insurance_policy', 'get_insurance_document_link', 'list_my_waivers', 'create_waiver', 'update_waiver', 'delete_waiver'];
    for (const name of vendorSide) expect(tool(name)).toMatchObject({ access: 'vendor', scope: 'listings' });
    for (const name of ['get_required_waivers', 'list_signed_waivers', 'sign_waiver']) expect(tool(name)).toMatchObject({ access: 'user', scope: 'bookings' });
    for (const name of ['delete_insurance_policy', 'delete_waiver']) expect(tool(name).annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    for (const name of ['list_my_insurance_policies', 'get_insurance_document_link', 'list_my_waivers', 'get_required_waivers', 'list_signed_waivers']) {
      expect(tool(name).annotations).toMatchObject({ readOnlyHint: true });
    }
    expect(tool('sign_waiver').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(INSURANCE_COVERAGE_TYPES).toEqual(['general_liability', 'commercial_property', 'inland_marine', 'other']);
    expect(WAIVER_KINDS).toEqual(['platform', 'vendor']);
  });

  it('validates path ids and enums through the zod shapes', () => {
    const { z } = jest.requireActual('zod') as typeof import('zod');
    expect(z.object(tool('delete_insurance_policy').inputSchema).safeParse({ policyId: 'not-a-uuid' }).success).toBe(false);
    expect(z.object(tool('update_waiver').inputSchema).safeParse({ waiverId: '../admin' }).success).toBe(false);
    expect(z.object(tool('get_required_waivers').inputSchema).safeParse({ listingId: 'x' }).success).toBe(false);
    expect(z.object(tool('get_required_waivers').inputSchema).safeParse({}).success).toBe(true);
    expect(z.object(tool('sign_waiver').inputSchema).safeParse({ kind: 'admin', waiverId: WAIVER, signature: 'Jane' }).success).toBe(false);
    expect(z.object(tool('add_insurance_policy').inputSchema).safeParse({ carrier: 'A', policyNumber: 'P', coverageType: 'umbrella', perOccurrenceLimit: 1, effectiveDate: '2026-01-01', expiryDate: '2027-01-01' }).success).toBe(false);
    expect(z.object(tool('add_insurance_policy').inputSchema).safeParse({ carrier: 'A', policyNumber: 'P', coverageType: 'other', perOccurrenceLimit: 1, effectiveDate: '2026-01-01', expiryDate: '2027-01-01', documentUrl: 'http://evil.example/x.pdf' }).success).toBe(false);
    expect(z.object(tool('create_waiver').inputSchema).safeParse({ name: 'W', content: 'c', minAge: null }).success).toBe(true);
    expect(z.object(tool('create_waiver').inputSchema).safeParse({ name: 'W', content: 'c', minAge: 0 }).success).toBe(false);
  });

  it('add_insurance_policy rejects incoherent dates locally and otherwise posts the DTO', async () => {
    const base = { carrier: 'Acme', policyNumber: 'GL-1', coverageType: 'general_liability', perOccurrenceLimit: 500000, effectiveDate: '2027-01-01', expiryDate: '2026-01-01' };
    const bad = await tool('add_insurance_policy').handler(base, vendorCtx);
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/expiryDate must be after effectiveDate/);
    expect(mockBackendRequest).not.toHaveBeenCalled();

    const invalid = await tool('add_insurance_policy').handler({ ...base, effectiveDate: 'soon' }, vendorCtx);
    expect(invalid.isError).toBe(true);
    expect(text(invalid)).toMatch(/Invalid effectiveDate/);

    mockBackendRequest.mockResolvedValueOnce({ id: POLICY, status: 'pending_review' });
    const good = await tool('add_insurance_policy').handler({ ...base, effectiveDate: '2026-01-01', expiryDate: '2027-01-01', aggregateLimit: 2_000_000 }, vendorCtx);
    expect(good.isError).toBeUndefined();
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/insurance-policies', opts: { token: T, body: { ...base, effectiveDate: '2026-01-01', expiryDate: '2027-01-01', aggregateLimit: 2_000_000 } } });
    expect(text(good)).toContain('pending_review');
  });

  it('update_insurance_policy requires a field, checks dates, and maps backend statuses', async () => {
    const empty = await tool('update_insurance_policy').handler({ policyId: POLICY }, vendorCtx);
    expect(empty.isError).toBe(true);
    expect(mockBackendRequest).not.toHaveBeenCalled();

    const badDates = await tool('update_insurance_policy').handler({ policyId: POLICY, effectiveDate: '2026-06-01', expiryDate: '2026-05-01' }, vendorCtx);
    expect(badDates.isError).toBe(true);

    await tool('update_insurance_policy').handler({ policyId: POLICY, expiryDate: '2028-01-01' }, vendorCtx);
    expect(lastCall()).toMatchObject({ method: 'PUT', path: `/insurance-policies/${POLICY}`, opts: { token: T, body: { expiryDate: '2028-01-01' } } });
    expect(lastCall().opts.body).not.toHaveProperty('policyId');

    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(409, 'Only a pending or rejected policy can be deleted'));
    const conflict = await tool('delete_insurance_policy').handler({ policyId: POLICY }, vendorCtx);
    expect(conflict.isError).toBe(true);
    expect(text(conflict)).toMatch(/^Conflict: Only a pending/);

    mockBackendRequest.mockResolvedValueOnce({ deleted: true });
    const deleted = await tool('delete_insurance_policy').handler({ policyId: POLICY }, vendorCtx);
    expect(JSON.parse(text(deleted))).toEqual({ deleted: true, policyId: POLICY });

    mockBackendRequest.mockResolvedValueOnce({ url: 'https://signed.example/doc.pdf?sig=1' });
    const link = await tool('get_insurance_document_link').handler({ policyId: POLICY }, vendorCtx);
    expect(JSON.parse(text(link))).toMatchObject({ policyId: POLICY, url: 'https://signed.example/doc.pdf?sig=1' });
  });

  it('waiver management handlers forward DTO bodies and handle void deletes', async () => {
    await tool('create_waiver').handler({ name: 'Liability', content: 'Text', minAge: 21 }, vendorCtx);
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/vendors/waivers', opts: { token: T, body: { name: 'Liability', content: 'Text', minAge: 21 } } });

    const empty = await tool('update_waiver').handler({ waiverId: WAIVER }, vendorCtx);
    expect(empty.isError).toBe(true);

    await tool('update_waiver').handler({ waiverId: WAIVER, isActive: false }, vendorCtx);
    expect(lastCall()).toMatchObject({ method: 'PUT', path: `/vendors/waivers/${WAIVER}`, opts: { token: T, body: { isActive: false } } });
    expect(lastCall().opts.body).not.toHaveProperty('waiverId');

    mockBackendRequest.mockResolvedValueOnce(undefined); // 200 with an empty body
    const deleted = await tool('delete_waiver').handler({ waiverId: WAIVER }, vendorCtx);
    expect(deleted.isError).toBeUndefined();
    expect(JSON.parse(text(deleted))).toMatchObject({ deleted: true, waiverId: WAIVER });
    expect(lastCall()).toMatchObject({ method: 'DELETE', path: `/vendors/waivers/${WAIVER}` });

    await tool('list_my_waivers').handler({}, vendorCtx);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/vendors/waivers', opts: { token: T } });
    await tool('list_my_insurance_policies').handler({}, vendorCtx);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/insurance-policies/mine', opts: { token: T } });
  });

  it('get_required_waivers normalizes both backend shapes into one summary', async () => {
    mockBackendRequest.mockResolvedValueOnce([
      { id: 'p1', name: 'Terms', type: 'platform', version: 2, signedVersion: 1, needsReSign: true, content: 'x' },
      { id: 'p2', name: 'Renter', type: 'platform', version: 1, signedVersion: 1, needsReSign: false, content: 'y' },
    ]);
    const platform = await tool('get_required_waivers').handler({}, renterCtx);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/waivers/required', opts: { token: T } });
    const summary = JSON.parse(text(platform));
    expect(summary).toMatchObject({ allSigned: false, unsigned: [{ id: 'p1', name: 'Terms', kind: 'platform', version: 2 }] });
    expect(summary.waivers).toHaveLength(2);
    expect(summary.nextStep).toMatch(/sign_waiver/);

    mockBackendRequest.mockResolvedValueOnce({ hasRequiredWaivers: true, waivers: [{ id: 'v1', name: 'Vendor rules', type: 'vendor', version: 1, signedVersion: 1, needsReSign: false }] });
    const scoped = await tool('get_required_waivers').handler({ listingId: LISTING }, renterCtx);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/waivers/listing/${LISTING}`, opts: { token: T } });
    expect(JSON.parse(text(scoped))).toMatchObject({ scope: `listing ${LISTING}`, allSigned: true, unsigned: [], nextStep: 'Nothing to sign.' });

    await tool('list_signed_waivers').handler({}, renterCtx);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/waivers/agreements', opts: { token: T } });
  });

  it('sign_waiver routes by kind, trims the signature and refuses a blank one', async () => {
    const blank = await tool('sign_waiver').handler({ kind: 'platform', waiverId: WAIVER, signature: '   ' }, renterCtx);
    expect(blank.isError).toBe(true);
    expect(mockBackendRequest).not.toHaveBeenCalled();

    await tool('sign_waiver').handler({ kind: 'platform', waiverId: WAIVER, signature: ' Jane Q Renter ' }, renterCtx);
    expect(lastCall()).toMatchObject({ method: 'POST', path: `/waivers/${WAIVER}/agree`, opts: { token: T, body: { signature: 'Jane Q Renter' } } });
    expect(lastCall().opts.body).not.toHaveProperty('bookingId');

    await tool('sign_waiver').handler({ kind: 'vendor', waiverId: WAIVER, signature: 'Jane Q Renter', bookingId: BOOKING }, renterCtx);
    expect(lastCall()).toMatchObject({ method: 'POST', path: `/waivers/vendor/${WAIVER}/agree`, opts: { token: T, body: { signature: 'Jane Q Renter', bookingId: BOOKING } } });

    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(400, 'This waiver is not yet approved'));
    const refused = await tool('sign_waiver').handler({ kind: 'vendor', waiverId: WAIVER, signature: 'Jane Q Renter' }, renterCtx);
    expect(refused.isError).toBe(true);
    expect(text(refused)).toBe('This waiver is not yet approved');
  });
});
