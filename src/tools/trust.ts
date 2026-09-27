/**
 * Post-rental money disputes: thin clients of the backend's `/disputes`,
 * `/claims` and `/incidental-charges` routes. Every call forwards the caller's
 * own JWT; the backend decides who is a party (renter of record / listing
 * owner) and drives each state machine. Only DTO fields are ever sent (the
 * backend's global ValidationPipe rejects undeclared fields with a 400).
 *
 * Three distinct processes:
 *   - Dispute: a free-text grievance either party opens on a booking; Splitt
 *     support adjudicates (open -> under_review -> resolved_* / compromise -> closed).
 *   - Damage claim: the vendor claims against the renter's held security
 *     deposit; the renter accepts or disputes within 72h; Splitt adjudicates and
 *     captures from the deposit (draft -> submitted -> renter_response ->
 *     admin_review -> resolved_* -> settled).
 *   - Incidental charge: the vendor bills the renter for fuel, cleaning, late
 *     return, mileage, damage or other costs; undisputed charges auto-capture
 *     after 72h (deposit first, then the saved card, else a hosted invoice).
 */
import { call, compact, qs } from './_shared';

export const DISPUTE_STATUSES = ['open', 'under_review', 'resolved_renter', 'resolved_vendor', 'compromise', 'closed'] as const;

export const CLAIM_STATES = ['draft', 'submitted', 'renter_response', 'admin_review', 'resolved_approved', 'resolved_partial', 'resolved_denied', 'settled'] as const;
export type ClaimState = (typeof CLAIM_STATES)[number];

export const CLAIM_EVIDENCE_TYPES = ['photo', 'receipt_pdf', 'statement'] as const;
export type ClaimEvidenceType = (typeof CLAIM_EVIDENCE_TYPES)[number];

export const CLAIM_RESPONSES = ['accepted', 'disputed'] as const;
export type ClaimResponse = (typeof CLAIM_RESPONSES)[number];

export const INCIDENTAL_CHARGE_TYPES = ['damage', 'fuel', 'cleaning', 'late_return', 'mileage', 'other'] as const;
export type IncidentalChargeType = (typeof INCIDENTAL_CHARGE_TYPES)[number];

export const INCIDENTAL_CHARGE_STATUSES = ['pending_review', 'disputed', 'captured', 'partially_captured', 'awaiting_payment', 'failed', 'cancelled'] as const;
export type IncidentalChargeStatus = (typeof INCIDENTAL_CHARGE_STATUSES)[number];

export const INCIDENTAL_RESPONSE_ACTIONS = ['accept', 'dispute'] as const;
export type IncidentalResponseAction = (typeof INCIDENTAL_RESPONSE_ACTIONS)[number];

/** `EvidenceItemDto` of the claims module. `internalOnly` is admin-only and never sent. */
export interface ClaimEvidenceItem {
  type: ClaimEvidenceType;
  fileUrl?: string;
  bookingVerificationId?: string;
  text?: string;
}

/** `EvidenceItemDto` of the incidental-charges module. */
export interface ChargeEvidenceItem {
  url: string;
  caption?: string;
}

export interface Pagination {
  limit?: number;
  offset?: number;
}

function compactEvidence<T extends object>(items: T[] | undefined): Partial<T>[] | undefined {
  return items?.length ? items.map((item) => compact(item)) : undefined;
}

export const trustApi = {
  // ── Disputes ─────────────────────────────────────────────────────────────

  listDisputes(token: string) {
    return call('GET', '/disputes', { token });
  },

  getDispute(token: string, disputeId: string) {
    return call('GET', `/disputes/${disputeId}`, { token });
  },

  openDispute(token: string, input: { bookingId: string; reason: string; evidenceUrls?: string[] }) {
    return call('POST', '/disputes', { token, body: compact({ ...input, evidenceUrls: input.evidenceUrls?.length ? input.evidenceUrls : undefined }) });
  },

  // ── Damage claims ────────────────────────────────────────────────────────

  listClaims(token: string, filters: Pagination & { state?: ClaimState } = {}) {
    return call('GET', `/claims${qs({ state: filters.state, limit: filters.limit, offset: filters.offset })}`, { token });
  },

  getClaim(token: string, claimId: string) {
    return call('GET', `/claims/${claimId}`, { token });
  },

  fileClaim(token: string, input: { bookingId: string; description: string; claimedAmount: number; evidence: ClaimEvidenceItem[] }) {
    return call('POST', '/claims', { token, body: compact({ ...input, evidence: compactEvidence(input.evidence) }) });
  },

  respondToClaim(token: string, claimId: string, input: { response: ClaimResponse; evidence?: ClaimEvidenceItem[] }) {
    return call('POST', `/claims/${claimId}/respond`, { token, body: compact({ response: input.response, evidence: compactEvidence(input.evidence) }) });
  },

  addClaimEvidence(token: string, claimId: string, item: ClaimEvidenceItem) {
    return call('POST', `/claims/${claimId}/evidence`, { token, body: compact(item) });
  },

  // ── Incidental charges ───────────────────────────────────────────────────

  listIncidentalCharges(token: string, filters: Pagination & { status?: IncidentalChargeStatus; bookingId?: string } = {}) {
    return call('GET', `/incidental-charges${qs({ status: filters.status, bookingId: filters.bookingId, limit: filters.limit, offset: filters.offset })}`, { token });
  },

  getIncidentalCharge(token: string, chargeId: string) {
    return call('GET', `/incidental-charges/${chargeId}`, { token });
  },

  fileIncidentalCharge(
    token: string,
    input: { bookingId: string; type: IncidentalChargeType; amount: number; description: string; evidence?: ChargeEvidenceItem[] },
  ) {
    return call('POST', '/incidental-charges', { token, body: compact({ ...input, evidence: compactEvidence(input.evidence) }) });
  },

  respondToIncidentalCharge(token: string, chargeId: string, input: { action: IncidentalResponseAction; note?: string }) {
    return call('POST', `/incidental-charges/${chargeId}/respond`, { token, body: compact(input) });
  },

  cancelIncidentalCharge(token: string, chargeId: string) {
    return call('POST', `/incidental-charges/${chargeId}/cancel`, { token, body: {} });
  },
};
