/**
 * Compliance backends: vendor insurance policies (SPLIT-747) and liability
 * e-waivers (platform waivers renters/vendors must sign, plus vendor-authored
 * waivers attached to a vendor's listings).
 *
 * Thin clients of the backend routes; the backend keys every read/write on the
 * JWT subject (a vendor can never touch another vendor's policy or waiver) and
 * owns the legal audit trail (frozen content snapshots, versioning, idempotent
 * re-signature). Bodies carry ONLY DTO fields: the backend's global
 * ValidationPipe rejects undeclared fields with a 400, so every body goes
 * through `compact()`.
 *
 * Insurance `documentUrl` values come from the `upload_file` tool (folder
 * "insurance"); uploads are not implemented here.
 */
import { call, compact, type Result } from './_shared';

export const INSURANCE_COVERAGE_TYPES = ['general_liability', 'commercial_property', 'inland_marine', 'other'] as const;
export type InsuranceCoverageType = (typeof INSURANCE_COVERAGE_TYPES)[number];

/** Body of POST /insurance-policies (CreateInsurancePolicyDto). */
export interface InsurancePolicyInput {
  carrier: string;
  policyNumber: string;
  coverageType: InsuranceCoverageType;
  perOccurrenceLimit: number;
  aggregateLimit?: number;
  effectiveDate: string;
  expiryDate: string;
  documentUrl?: string;
}

/** Body of POST /vendors/waivers (CreateVendorWaiverDto). `minAge: null` = no age requirement. */
export interface VendorWaiverInput {
  name: string;
  description?: string;
  content: string;
  minAge?: number | null;
}

/** Body of PUT /vendors/waivers/:id (UpdateVendorWaiverDto). */
export type VendorWaiverUpdate = Partial<VendorWaiverInput> & { isActive?: boolean };

export const WAIVER_KINDS = ['platform', 'vendor'] as const;
export type WaiverKind = (typeof WAIVER_KINDS)[number];

export interface SignWaiverInput {
  signature: string;
  bookingId?: string;
}

/** GET /waivers/required returns a bare array; GET /waivers/listing/:id wraps it with the booking gate. */
export type RequiredWaiversResponse = unknown[] | { hasRequiredWaivers: boolean; waivers: unknown[] };

export const complianceApi = {
  // ── Insurance policies (vendor family; /insurance-policies) ───────────────

  listMyInsurancePolicies(token: string) {
    return call('GET', '/insurance-policies/mine', { token });
  },

  addInsurancePolicy(token: string, input: InsurancePolicyInput) {
    return call('POST', '/insurance-policies', { token, body: compact(input) });
  },

  /** Any successful edit resets the policy to `pending_review`. */
  updateInsurancePolicy(token: string, policyId: string, input: Partial<InsurancePolicyInput>) {
    return call('PUT', `/insurance-policies/${policyId}`, { token, body: compact(input) });
  },

  /** Only a `pending_review` or `rejected` policy can be deleted (409 otherwise). */
  deleteInsurancePolicy(token: string, policyId: string) {
    return call<{ deleted?: boolean }>('DELETE', `/insurance-policies/${policyId}`, { token });
  },

  /** Short-lived signed read URL for the policy document (404 when none is attached). */
  getInsuranceDocumentUrl(token: string, policyId: string) {
    return call<{ url: string }>('GET', `/insurance-policies/${policyId}/document-url`, { token });
  },

  // ── Vendor waivers (vendor family; /vendors/waivers) ──────────────────────

  listMyWaivers(token: string) {
    return call('GET', '/vendors/waivers', { token });
  },

  createWaiver(token: string, input: VendorWaiverInput) {
    return call('POST', '/vendors/waivers', { token, body: compact(input) });
  },

  /** A content change bumps the version and clears approval; renters must re-sign. */
  updateWaiver(token: string, waiverId: string, input: VendorWaiverUpdate) {
    return call('PUT', `/vendors/waivers/${waiverId}`, { token, body: compact(input) });
  },

  /** Hard-deletes an unsigned waiver; a signed one is deactivated instead (record retained). */
  deleteWaiver(token: string, waiverId: string) {
    return call<void>('DELETE', `/vendors/waivers/${waiverId}`, { token });
  },

  // ── Waiver signing (any signed-in user; /waivers) ─────────────────────────

  /**
   * Without a listing: the platform waivers that apply to the user's role
   * (array of RequiredWaiver). With a listing: platform waivers scoped to that
   * listing's category PLUS the listing owner's approved vendor waivers
   * (`{ hasRequiredWaivers, waivers }`).
   */
  getRequiredWaivers(token: string, listingId?: string): Promise<Result<RequiredWaiversResponse>> {
    return call<RequiredWaiversResponse>('GET', listingId ? `/waivers/listing/${listingId}` : '/waivers/required', { token });
  },

  listSignedWaivers(token: string) {
    return call('GET', '/waivers/agreements', { token });
  },

  /** Records a legally binding e-signature. Idempotent per waiver version + booking on the backend. */
  signWaiver(token: string, kind: WaiverKind, waiverId: string, input: SignWaiverInput) {
    const path = kind === 'vendor' ? `/waivers/vendor/${waiverId}/agree` : `/waivers/${waiverId}/agree`;
    return call('POST', path, { token, body: compact(input) });
  },
};
