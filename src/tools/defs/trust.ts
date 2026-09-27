/**
 * Post-rental money disputes: disputes (either party), damage claims against the
 * security deposit (vendor files, renter responds) and incidental charges
 * (vendor files, renter accepts / disputes, vendor cancels). All are formal
 * processes that affect money; the descriptions tell the model to confirm with
 * the user before filing or responding.
 */
import { z } from 'zod';
import { defineTool, fail, fromResult } from '../registry';
import {
  trustApi,
  CLAIM_STATES,
  CLAIM_EVIDENCE_TYPES,
  CLAIM_RESPONSES,
  INCIDENTAL_CHARGE_TYPES,
  INCIDENTAL_CHARGE_STATUSES,
  INCIDENTAL_RESPONSE_ACTIONS,
  type ClaimEvidenceItem,
} from '../trust';
import { uuid, pagination, READ, WRITE, DESTRUCTIVE, UNTRUSTED_NOTE, token } from './common';

const FORMAL_NOTE = 'This is a formal process that affects money; confirm the details with the user before calling it.';

const evidenceUrl = z.string().url().max(2048);

/** One claim evidence item (the backend's EvidenceItemDto minus the admin-only internalOnly flag). */
const claimEvidenceItem = z.object({
  type: z.enum(CLAIM_EVIDENCE_TYPES).describe('photo or receipt_pdf carry a fileUrl from upload_file (folder "claims"); statement carries text only.'),
  fileUrl: evidenceUrl.optional().describe('Required for photo / receipt_pdf: the url returned by upload_file with folder "claims".'),
  bookingVerificationId: z.string().uuid().optional().describe('Optional link to a pickup / return inspection photo set.'),
  text: z.string().max(2000).optional().describe('Caption or statement text (required for statement).'),
});

const chargeEvidenceItem = z.object({
  url: evidenceUrl.describe('The url returned by upload_file with folder "incidental-charges".'),
  caption: z.string().max(500).optional(),
});

/** Validate evidence items the way the backend does, so the user gets a clear message before any round-trip. */
function claimEvidenceError(items: ClaimEvidenceItem[] | undefined, requireProof: boolean): string | null {
  for (const item of items ?? []) {
    if (item.type === 'statement') {
      if (!item.text?.trim()) return 'A statement evidence item needs text.';
    } else if (!item.fileUrl) {
      return `A ${item.type} evidence item needs a fileUrl (upload it first with upload_file, folder "claims").`;
    }
  }
  if (requireProof && !(items ?? []).some((item) => item.type === 'photo' || item.type === 'receipt_pdf')) {
    return 'At least one photo or receipt_pdf evidence item is required to file a damage claim.';
  }
  return null;
}

/** Point the user at a hosted invoice when a capture fell back to a payment request. */
function withChargeNextStep(charge: unknown): unknown {
  const c = charge as { status?: string; hostedInvoiceUrl?: string | null } | null;
  if (c && typeof c === 'object' && c.status === 'awaiting_payment' && c.hostedInvoiceUrl) {
    return { charge, nextStep: 'The charge could not be taken from the deposit or saved card. Send the renter to hostedInvoiceUrl to pay (never collect card details yourself).' };
  }
  return charge;
}

// ── Disputes ─────────────────────────────────────────────────────────────────

export const listDisputes = defineTool({
  name: 'list_disputes',
  title: 'My disputes',
  description:
    'Disputes on bookings the signed-in user is a party to (as renter or as vendor), newest first: status (open, under_review, resolved_renter, resolved_vendor, ' +
    'compromise, closed), reason, evidence links (short-lived signed URLs) and the booking. A dispute is a grievance about a booking that Splitt support reviews; ' +
    'its outcome can change refunds or payouts. Use get_dispute for one dispute. ' +
    UNTRUSTED_NOTE,
  access: 'user',
  scope: 'claims',
  inputSchema: {},
  annotations: READ,
  handler: async (_args, ctx) => fromResult(await trustApi.listDisputes(token(ctx))),
});

export const getDispute = defineTool({
  name: 'get_dispute',
  title: 'Get a dispute',
  description: 'Full details of one dispute the signed-in user is a party to: status, reason, evidence links, the booking and who opened it. ' + UNTRUSTED_NOTE,
  access: 'user',
  scope: 'claims',
  inputSchema: { disputeId: uuid('dispute') },
  annotations: READ,
  handler: async ({ disputeId }, ctx) => fromResult(await trustApi.getDispute(token(ctx), disputeId)),
});

export const openDispute = defineTool({
  name: 'open_dispute',
  title: 'Open a dispute',
  description:
    'Open a formal dispute on a booking as the signed-in user (renter or vendor). Splitt support reviews it and the outcome can change refunds or payouts. ' +
    'Rules: one dispute per booking, within 30 days of the rental end date, not on pending / rejected / cancelled bookings. Upload evidence first with ' +
    'upload_file (folder "disputes") and pass the URLs. It cannot be withdrawn by the party once opened. ' +
    FORMAL_NOTE,
  access: 'user',
  scope: 'claims',
  inputSchema: {
    bookingId: uuid('booking'),
    reason: z.string().min(10).max(2000).describe('What happened and what outcome the user wants (max 2000 characters).'),
    evidenceUrls: z.array(evidenceUrl).max(20).optional().describe('URLs from upload_file with folder "disputes".'),
  },
  annotations: DESTRUCTIVE,
  handler: async ({ bookingId, reason, evidenceUrls }, ctx) => fromResult(await trustApi.openDispute(token(ctx), { bookingId, reason, evidenceUrls })),
});

// ── Damage claims ────────────────────────────────────────────────────────────

export const listClaims = defineTool({
  name: 'list_claims',
  title: 'My damage claims',
  description:
    'Damage claims involving the signed-in user, newest first: vendors see claims on their listings, renters see claims on their bookings. Each row has the state ' +
    '(draft, submitted, renter_response, admin_review, resolved_approved, resolved_partial, resolved_denied, settled), claimed / approved amounts, the renter ' +
    'response and deadlines; evidence is only in get_claim. Filter by state and page with limit / offset.',
  access: 'user',
  scope: 'claims',
  inputSchema: {
    state: z.enum(CLAIM_STATES).optional().describe('Only claims in this state.'),
    ...pagination,
  },
  annotations: READ,
  handler: async ({ state, limit, offset }, ctx) => fromResult(await trustApi.listClaims(token(ctx), { state, limit, offset })),
});

export const getClaim = defineTool({
  name: 'get_claim',
  title: 'Get a damage claim',
  description:
    'Full details of one damage claim the signed-in user is a party to: state, description, claimed / approved / overage amounts, renter response, deadlines, ' +
    'evidence (both parties see the same evidence; file links are short-lived signed URLs) and the booking inspection status. ' +
    UNTRUSTED_NOTE,
  access: 'user',
  scope: 'claims',
  inputSchema: { claimId: uuid('claim') },
  annotations: READ,
  handler: async ({ claimId }, ctx) => fromResult(await trustApi.getClaim(token(ctx), claimId)),
});

export const fileDamageClaim = defineTool({
  name: 'file_damage_claim',
  title: 'File a damage claim',
  description:
    'File a damage claim against the security deposit of a booking on one of the signed-in vendor\'s listings. The renter gets 72 hours to accept or dispute, ' +
    'then Splitt adjudicates and captures the approved amount from the deposit (anything above the deposit is recorded as an unrecovered overage). ' +
    'Rules: the booking must be confirmed or completed with a held deposit; one claim per booking; filing closes about 48 hours after the rental end; at least one ' +
    'photo or receipt_pdf evidence item is required (upload with upload_file, folder "claims"). ' +
    FORMAL_NOTE,
  access: 'vendor',
  scope: 'claims',
  inputSchema: {
    bookingId: uuid('booking'),
    description: z.string().min(10).max(2000).describe('What was damaged and how (max 2000 characters).'),
    claimedAmount: z.number().positive().max(1_000_000).multipleOf(0.01).describe('Amount claimed against the deposit, in USD (2 decimals).'),
    evidence: z.array(claimEvidenceItem).min(1).max(30).describe('At least one photo or receipt_pdf item; statements are optional extras.'),
  },
  annotations: DESTRUCTIVE,
  handler: async ({ bookingId, description, claimedAmount, evidence }, ctx) => {
    const err = claimEvidenceError(evidence, true);
    if (err) return fail(err);
    return fromResult(await trustApi.fileClaim(token(ctx), { bookingId, description, claimedAmount, evidence }));
  },
});

export const respondToClaim = defineTool({
  name: 'respond_to_claim',
  title: 'Respond to a damage claim',
  description:
    'Answer a submitted damage claim as the renter of the booking: "accepted" agrees that the claimed amount may be taken from the security deposit; "disputed" ' +
    'contests it. Either way the claim moves to Splitt review and the response cannot be changed. Optional counter-evidence (photos / receipts uploaded with ' +
    'upload_file, folder "claims", or a statement) is attached with the response. Only the renter who booked can respond; the window is 72 hours after submission. ' +
    FORMAL_NOTE,
  access: 'user',
  scope: 'claims',
  inputSchema: {
    claimId: uuid('claim'),
    response: z.enum(CLAIM_RESPONSES),
    evidence: z.array(claimEvidenceItem).max(30).optional().describe('Counter-evidence to attach with the response.'),
  },
  annotations: DESTRUCTIVE,
  handler: async ({ claimId, response, evidence }, ctx) => {
    const err = claimEvidenceError(evidence, false);
    if (err) return fail(err);
    return fromResult(await trustApi.respondToClaim(token(ctx), claimId, { response, evidence }));
  },
});

export const addClaimEvidence = defineTool({
  name: 'add_claim_evidence',
  title: 'Add claim evidence',
  description:
    'Attach one more piece of evidence to a damage claim the signed-in user is a party to (renter or vendor): a photo or receipt_pdf uploaded with upload_file ' +
    '(folder "claims"), or a written statement. Both parties see all evidence; nothing can be added once the claim is settled. Returns the stored evidence item.',
  access: 'user',
  scope: 'claims',
  inputSchema: {
    claimId: uuid('claim'),
    ...claimEvidenceItem.shape,
  },
  annotations: WRITE,
  handler: async ({ claimId, ...item }, ctx) => {
    const err = claimEvidenceError([item], false);
    if (err) return fail(err);
    return fromResult(await trustApi.addClaimEvidence(token(ctx), claimId, item));
  },
});

// ── Incidental charges ───────────────────────────────────────────────────────

export const listIncidentalCharges = defineTool({
  name: 'list_incidental_charges',
  title: 'My incidental charges',
  description:
    'Post-rental incidental charges involving the signed-in user, newest first: vendors see charges they filed on their listings, renters see charges on their ' +
    'bookings. Each has a type (damage, fuel, cleaning, late_return, mileage, other), status (pending_review, disputed, captured, partially_captured, ' +
    'awaiting_payment, failed, cancelled), amount, captured amounts, evidence, the renter response and the 72-hour dispute deadline. Filter by status or booking.',
  access: 'user',
  scope: 'claims',
  inputSchema: {
    status: z.enum(INCIDENTAL_CHARGE_STATUSES).optional(),
    bookingId: z.string().uuid().optional().describe('Only charges on this booking.'),
    ...pagination,
  },
  annotations: READ,
  handler: async ({ status, bookingId, limit, offset }, ctx) => fromResult(await trustApi.listIncidentalCharges(token(ctx), { status, bookingId, limit, offset })),
});

export const getIncidentalCharge = defineTool({
  name: 'get_incidental_charge',
  title: 'Get an incidental charge',
  description:
    'Full details of one incidental charge the signed-in user is a party to: type, status, amount and what was captured, description, evidence (short-lived ' +
    'signed URLs), the renter response, deadlines and a hostedInvoiceUrl when a payment request was issued. ' +
    UNTRUSTED_NOTE,
  access: 'user',
  scope: 'claims',
  inputSchema: { chargeId: uuid('incidental charge') },
  annotations: READ,
  handler: async ({ chargeId }, ctx) => fromResult(await trustApi.getIncidentalCharge(token(ctx), chargeId)),
});

export const fileIncidentalCharge = defineTool({
  name: 'file_incidental_charge',
  title: 'File an incidental charge',
  description:
    'Bill the renter of a booking on one of the signed-in vendor\'s listings for a post-rental cost: damage, fuel, cleaning, late_return, mileage or other. The renter ' +
    'is notified and has 72 hours to accept or dispute; an undisputed charge is captured automatically (deposit first, then the renter\'s saved card, otherwise a ' +
    'hosted payment request). Rules: the booking must be confirmed or completed; filing closes 14 days after the rental end; the amount may not exceed the ' +
    'booking-derived cap Splitt enforces; a damage charge needs at least one evidence item (upload with upload_file, folder "incidental-charges"). ' +
    FORMAL_NOTE,
  access: 'vendor',
  scope: 'claims',
  inputSchema: {
    bookingId: uuid('booking'),
    type: z.enum(INCIDENTAL_CHARGE_TYPES),
    amount: z.number().positive().max(1_000_000).multipleOf(0.01).describe('Amount requested from the renter, in USD (2 decimals).'),
    description: z.string().min(10).max(2000).describe('Itemized, renter-facing explanation of the charge (max 2000 characters).'),
    evidence: z.array(chargeEvidenceItem).max(30).optional().describe('Renter-visible photos / receipts; required for damage.'),
  },
  annotations: DESTRUCTIVE,
  handler: async ({ bookingId, type, amount, description, evidence }, ctx) => {
    if (type === 'damage' && !evidence?.length) return fail('A damage charge needs at least one evidence item (upload it first with upload_file, folder "incidental-charges").');
    return fromResult(await trustApi.fileIncidentalCharge(token(ctx), { bookingId, type, amount, description, evidence }), withChargeNextStep);
  },
});

export const respondToIncidentalCharge = defineTool({
  name: 'respond_to_incidental_charge',
  title: 'Respond to an incidental charge',
  description:
    'Answer a pending incidental charge as the renter of the booking: "accept" captures the amount immediately (from the deposit, then the saved card; if neither ' +
    'works the result carries a hostedInvoiceUrl for the renter to pay), "dispute" escalates it to Splitt review with the note as the reason and no money moves yet. ' +
    'Only the renter who booked can respond, only while the charge is pending_review, and the answer is final. ' +
    FORMAL_NOTE,
  access: 'user',
  scope: 'claims',
  inputSchema: {
    chargeId: uuid('incidental charge'),
    action: z.enum(INCIDENTAL_RESPONSE_ACTIONS),
    note: z.string().max(2000).optional().describe('Optional note; stored as the dispute reason when disputing.'),
  },
  annotations: DESTRUCTIVE,
  handler: async ({ chargeId, action, note }, ctx) => {
    if (action === 'dispute' && !note?.trim()) return fail('Give a note explaining why the charge is disputed.');
    return fromResult(await trustApi.respondToIncidentalCharge(token(ctx), chargeId, { action, note }), withChargeNextStep);
  },
});

export const cancelIncidentalCharge = defineTool({
  name: 'cancel_incidental_charge',
  title: 'Withdraw an incidental charge',
  description:
    'Withdraw an incidental charge the signed-in vendor filed while it is still pending_review or disputed. The renter is told no payment was taken; the charge ' +
    'becomes cancelled and cannot be reopened (file a new one if needed). Confirm with the user first.',
  access: 'vendor',
  scope: 'claims',
  inputSchema: { chargeId: uuid('incidental charge') },
  annotations: DESTRUCTIVE,
  handler: async ({ chargeId }, ctx) => fromResult(await trustApi.cancelIncidentalCharge(token(ctx), chargeId)),
});

export const trustTools = [
  listDisputes,
  getDispute,
  openDispute,
  listClaims,
  getClaim,
  fileDamageClaim,
  respondToClaim,
  addClaimEvidence,
  listIncidentalCharges,
  getIncidentalCharge,
  fileIncidentalCharge,
  respondToIncidentalCharge,
  cancelIncidentalCharge,
];
