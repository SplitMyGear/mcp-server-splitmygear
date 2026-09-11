/**
 * Compliance tools: vendor insurance certificates and liability waivers.
 *
 *   vendor family  → insurance policy registry + the vendor's own waivers (scope `listings`)
 *   any user       → required / signed waivers and e-signing (scope `bookings`)
 *
 * Insurance documents are uploaded with the `upload_file` tool (folder
 * "insurance"); this module only stores the returned URL.
 */
import { z } from 'zod';
import { defineTool, fail, fromResult } from '../registry';
import { complianceApi, INSURANCE_COVERAGE_TYPES, WAIVER_KINDS } from '../compliance';
import { dateError } from '../_shared';
import { uuid, isoDate, READ, WRITE, WRITE_IDEMPOTENT, DESTRUCTIVE, UNTRUSTED_NOTE, token } from './common';

// ── Insurance policies ───────────────────────────────────────────────────────

const carrier = z.string().min(1).max(120).describe('Insurance carrier (insurer) name.');
const policyNumber = z.string().min(1).max(120).describe('Policy number as printed on the declaration page.');
const coverageType = z.enum(INSURANCE_COVERAGE_TYPES).describe('Kind of coverage: general_liability, commercial_property, inland_marine, or other.');
const perOccurrenceLimit = z.number().positive().max(9_999_999_999).describe('Per-occurrence coverage limit in USD (up to 2 decimals).');
const aggregateLimit = z.number().positive().max(9_999_999_999).describe('Aggregate coverage limit in USD (up to 2 decimals).');
const documentUrl = z
  .string()
  .url()
  .startsWith('https://')
  .max(1024)
  .describe('URL of the uploaded declaration page / certificate of insurance (PDF or image): upload it first with upload_file using folder "insurance" and pass the returned url. URLs on other hosts are rejected by Splitt.');

/** Returns a message when the dates are not both valid with expiry strictly after effective; null when fine. */
function policyDatesError(effectiveDate?: string, expiryDate?: string): string | null {
  if (effectiveDate !== undefined) {
    const e = dateError('effectiveDate', effectiveDate);
    if (e) return e;
  }
  if (expiryDate !== undefined) {
    const e = dateError('expiryDate', expiryDate);
    if (e) return e;
  }
  if (effectiveDate !== undefined && expiryDate !== undefined && new Date(expiryDate).getTime() <= new Date(effectiveDate).getTime()) {
    return 'expiryDate must be after effectiveDate.';
  }
  return null;
}

export const listMyInsurancePolicies = defineTool({
  name: 'list_my_insurance_policies',
  title: 'My insurance policies',
  description:
    'Insurance policies the signed-in vendor has registered with Splitt (carrier, policy number, coverage type, limits, effective/expiry dates, whether a document is attached) ' +
    'and each one\'s review status: pending_review, verified (counts as active insurance and is snapshotted onto bookings), rejected (with the reviewer\'s reason) or expired. ' +
    'Use it to check coverage status before renting out gear or to find a policyId for the other insurance tools.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: {},
  annotations: READ,
  handler: async (_args, ctx) => fromResult(await complianceApi.listMyInsurancePolicies(token(ctx))),
});

export const addInsurancePolicy = defineTool({
  name: 'add_insurance_policy',
  title: 'Register insurance policy',
  description:
    'Register a liability / property insurance policy for the signed-in vendor. It is submitted as pending_review; Splitt staff verify it against the attached document before it counts as active coverage. ' +
    'To attach the declaration page or certificate, upload it first with upload_file (folder "insurance") and pass the returned url as documentUrl. ' +
    'Returns the created policy with its id and status. Confirm the details with the user before submitting.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: {
    carrier,
    policyNumber,
    coverageType,
    perOccurrenceLimit,
    aggregateLimit: aggregateLimit.optional(),
    effectiveDate: isoDate('Policy effective (start) date'),
    expiryDate: isoDate('Policy expiry date; must be after the effective date'),
    documentUrl: documentUrl.optional(),
  },
  annotations: WRITE,
  handler: async (args, ctx) => {
    const err = policyDatesError(args.effectiveDate, args.expiryDate);
    if (err) return fail(err);
    return fromResult(await complianceApi.addInsurancePolicy(token(ctx), args));
  },
});

export const updateInsurancePolicy = defineTool({
  name: 'update_insurance_policy',
  title: 'Update insurance policy',
  description:
    'Edit one of the signed-in vendor\'s insurance policies (only the fields you pass change; use list_my_insurance_policies to see current values). ' +
    'Any successful edit is treated as material: the policy goes back to pending_review and stops counting as active coverage until Splitt re-verifies it, so warn the user before editing a verified policy. ' +
    'Use this to fix a rejected policy or to attach a new document (from upload_file). Returns the updated policy.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: {
    policyId: uuid('insurance policy'),
    carrier: carrier.optional(),
    policyNumber: policyNumber.optional(),
    coverageType: coverageType.optional(),
    perOccurrenceLimit: perOccurrenceLimit.optional(),
    aggregateLimit: aggregateLimit.optional(),
    effectiveDate: isoDate('New effective (start) date').optional(),
    expiryDate: isoDate('New expiry date').optional(),
    documentUrl: documentUrl.optional(),
  },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ policyId, ...rest }, ctx) => {
    if (Object.values(rest).every((v) => v === undefined)) return fail('Pass at least one field to update.');
    const err = policyDatesError(rest.effectiveDate, rest.expiryDate);
    if (err) return fail(err);
    return fromResult(await complianceApi.updateInsurancePolicy(token(ctx), policyId, rest));
  },
});

export const deleteInsurancePolicy = defineTool({
  name: 'delete_insurance_policy',
  title: 'Delete insurance policy',
  description:
    'Permanently remove one of the signed-in vendor\'s insurance policies. Splitt only allows this while the policy is pending_review or rejected; a verified or expired policy cannot be deleted (Conflict). ' +
    'This cannot be undone: confirm with the user first, naming the carrier and policy number.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: { policyId: uuid('insurance policy') },
  annotations: DESTRUCTIVE,
  handler: async ({ policyId }, ctx) => fromResult(await complianceApi.deleteInsurancePolicy(token(ctx), policyId), () => ({ deleted: true, policyId })),
});

export const getInsuranceDocumentLink = defineTool({
  name: 'get_insurance_document_link',
  title: 'Insurance document link',
  description:
    'Get a short-lived signed URL to view the document attached to one of the signed-in vendor\'s insurance policies (declaration page / certificate of insurance). ' +
    'Give the URL to the user to open in a browser; it expires after a short time, so request a fresh one when needed. Fails with Not found when the policy has no document.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: { policyId: uuid('insurance policy') },
  annotations: READ,
  handler: async ({ policyId }, ctx) =>
    fromResult(await complianceApi.getInsuranceDocumentUrl(token(ctx), policyId), (d) => ({
      policyId,
      url: d?.url ?? d,
      note: 'This link is short-lived; request a fresh one if it has expired.',
    })),
});

// ── Vendor waivers ───────────────────────────────────────────────────────────

const waiverName = z.string().min(1).max(255).describe('Short title renters see, e.g. "E-bike rental liability waiver".');
const waiverDescription = z.string().max(500).describe('One-line summary shown above the waiver text.');
const waiverContent = z
  .string()
  .min(1)
  .max(100_000)
  .describe('The full waiver text renters must agree to (plain text or simple HTML; Splitt strips unsafe markup). This exact text is frozen into each signature record.');
const waiverMinAge = z.number().int().min(1).max(120).nullable().describe('Minimum signer age in years; pass null for no age requirement.');

export const listMyWaivers = defineTool({
  name: 'list_my_waivers',
  title: 'My waivers',
  description:
    'Liability waivers the signed-in vendor has written for their listings, each with its full text, version, minAge, isActive and isApproved. ' +
    'Renters booking any of the vendor\'s listings must sign every waiver that is active AND approved by Splitt; a waiver whose text was just created or changed waits for approval first. ' +
    'Use it to review current terms or to find a waiverId for update_waiver / delete_waiver.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: {},
  annotations: READ,
  handler: async (_args, ctx) => fromResult(await complianceApi.listMyWaivers(token(ctx))),
});

export const createWaiver = defineTool({
  name: 'create_waiver',
  title: 'Create a waiver',
  description:
    'Write a new liability waiver that renters must e-sign before booking any of the signed-in vendor\'s listings. It starts active but unapproved: Splitt staff review the text before renters are asked to sign it. ' +
    'Optionally set a minimum signer age. Draft the wording with the user and have them confirm the final text before creating; the waiver is a legal document. Returns the created waiver (version 1).',
  access: 'vendor',
  scope: 'listings',
  inputSchema: {
    name: waiverName,
    description: waiverDescription.optional(),
    content: waiverContent,
    minAge: waiverMinAge.optional(),
  },
  annotations: WRITE,
  handler: async (args, ctx) => fromResult(await complianceApi.createWaiver(token(ctx), args)),
});

export const updateWaiver = defineTool({
  name: 'update_waiver',
  title: 'Update a waiver',
  description:
    'Change one of the signed-in vendor\'s waivers (only the fields you pass change). Changing the content publishes a new version: Splitt must approve it again and renters who signed the old version will be asked to re-sign; ' +
    'earlier signatures keep the text they agreed to. Set isActive=false to stop asking renters to sign it without deleting it, or true to reinstate it. Returns the updated waiver.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: {
    waiverId: uuid('waiver'),
    name: waiverName.optional(),
    description: waiverDescription.optional(),
    content: waiverContent.optional(),
    minAge: waiverMinAge.optional(),
    isActive: z.boolean().optional().describe('false hides the waiver from renters (no new signatures required); true reactivates it.'),
  },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ waiverId, ...rest }, ctx) => {
    if (Object.values(rest).every((v) => v === undefined)) return fail('Pass at least one field to update.');
    return fromResult(await complianceApi.updateWaiver(token(ctx), waiverId, rest));
  },
});

export const deleteWaiver = defineTool({
  name: 'delete_waiver',
  title: 'Delete a waiver',
  description:
    'Remove one of the signed-in vendor\'s waivers. A waiver nobody has signed is deleted permanently; one that renters have already signed is deactivated instead (the signed records must be retained) and disappears from the booking flow. ' +
    'Prefer update_waiver with isActive=false to pause a waiver. Confirm with the user first.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: { waiverId: uuid('waiver') },
  annotations: DESTRUCTIVE,
  handler: async ({ waiverId }, ctx) =>
    fromResult(await complianceApi.deleteWaiver(token(ctx), waiverId), () => ({
      deleted: true,
      waiverId,
      note: 'If renters had already signed this waiver, Splitt deactivated it instead of deleting it and kept the signed records.',
    })),
});

// ── Waiver signing (renters and any signed-in user) ──────────────────────────

interface RequiredWaiverLike {
  id?: string;
  name?: string;
  type?: string;
  version?: number;
  signedVersion?: number;
  needsReSign?: boolean;
}

function summarizeRequired(list: unknown[], scope: string) {
  const waivers = list.filter((w): w is RequiredWaiverLike => !!w && typeof w === 'object');
  const unsigned = waivers.filter((w) => w.needsReSign).map((w) => ({ id: w.id, name: w.name, kind: w.type, version: w.version }));
  return {
    scope,
    allSigned: unsigned.length === 0,
    unsigned,
    waivers,
    nextStep: unsigned.length
      ? 'Show the user each unsigned waiver\'s full text; once they have read it and typed their full legal name, call sign_waiver with that name as the signature.'
      : 'Nothing to sign.',
  };
}

export const getRequiredWaivers = defineTool({
  name: 'get_required_waivers',
  title: 'Required waivers',
  description:
    'Waivers the signed-in user must e-sign, with full text, version and whether each one still needs a signature (needsReSign is true when unsigned or signed on an older version). ' +
    'Without listingId: the Splitt platform waivers that apply to the user\'s role (renters before booking; vendors during onboarding). With listingId: everything required to book that listing, ' +
    'i.e. platform waivers for its category plus the listing owner\'s approved vendor waivers, with allSigned telling you whether the booking may proceed. Call this when a booking is refused for unsigned waivers. ' +
    UNTRUSTED_NOTE +
    ' Vendor waiver text is written by the vendor.',
  access: 'user',
  scope: 'bookings',
  inputSchema: {
    listingId: z.string().uuid().optional().describe('Scope to what is required to book this listing (platform + that vendor\'s waivers). Omit for the user\'s platform waivers only.'),
  },
  annotations: READ,
  handler: async ({ listingId }, ctx) =>
    fromResult(await complianceApi.getRequiredWaivers(token(ctx), listingId), (data) => {
      const list = Array.isArray(data) ? data : Array.isArray((data as { waivers?: unknown[] })?.waivers) ? (data as { waivers: unknown[] }).waivers : [];
      return summarizeRequired(list, listingId ? `listing ${listingId}` : 'platform waivers for this account');
    }),
});

export const listSignedWaivers = defineTool({
  name: 'list_signed_waivers',
  title: 'My signed waivers',
  description:
    'Every waiver agreement the signed-in user has e-signed (platform and vendor waivers), newest first: which waiver and version, the typed signature, when it was signed, the booking it was for, ' +
    'and the exact text agreed to at the time. Use it to answer "what have I signed?" or to check whether a waiver needs re-signing after its text changed.',
  access: 'user',
  scope: 'bookings',
  inputSchema: {},
  annotations: READ,
  handler: async (_args, ctx) => fromResult(await complianceApi.listSignedWaivers(token(ctx))),
});

export const signWaiver = defineTool({
  name: 'sign_waiver',
  title: 'Sign a waiver',
  description:
    'Record the signed-in user\'s legally binding electronic signature on a waiver from get_required_waivers: kind "platform" for a Splitt waiver, "vendor" for a listing owner\'s waiver (the `type` field). ' +
    'Only call this after the user has been shown the full waiver text, has confirmed they agree, and has themselves provided their full legal name to use as the signature; never sign on the user\'s behalf or invent a name. ' +
    'Pass bookingId when signing for a specific booking. Splitt records the signer, time, version and frozen text; it refuses if the user is under the waiver\'s minimum age or the waiver is not yet approved. ' +
    'Re-signing the same version is harmless (returns the existing agreement).',
  access: 'user',
  scope: 'bookings',
  inputSchema: {
    kind: z.enum(WAIVER_KINDS).describe('"platform" for a Splitt platform waiver, "vendor" for a vendor\'s own waiver (matches the `type` of the required waiver).'),
    waiverId: uuid('waiver'),
    signature: z.string().min(2).max(200).describe('The user\'s full legal name, exactly as they typed it, as their electronic signature.'),
    bookingId: z.string().uuid().optional().describe('Booking this signature is for, if any.'),
  },
  annotations: WRITE,
  handler: async ({ kind, waiverId, signature, bookingId }, ctx) => {
    const trimmed = signature.trim();
    if (trimmed.length < 2) return fail('signature must be the user\'s full name (at least 2 characters).');
    return fromResult(await complianceApi.signWaiver(token(ctx), kind, waiverId, { signature: trimmed, bookingId }));
  },
});

export const complianceTools = [
  listMyInsurancePolicies,
  addInsurancePolicy,
  updateInsurancePolicy,
  deleteInsurancePolicy,
  getInsuranceDocumentLink,
  listMyWaivers,
  createWaiver,
  updateWaiver,
  deleteWaiver,
  getRequiredWaivers,
  listSignedWaivers,
  signWaiver,
];
