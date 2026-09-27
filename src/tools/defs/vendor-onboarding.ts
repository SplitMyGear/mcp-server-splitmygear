/**
 * Become-a-vendor onboarding wizard: apply, business profile, Stripe payouts,
 * vendor agreement. The applicant is still a renter while in the pipeline, so
 * every tool here is `user` access (JWT only) and `profile` scope. The current
 * step is read with the existing get_vendor_onboarding_status tool.
 *
 * Pipeline (backend VendorOnboardingStatus state machine):
 *   not_started -> apply (applied, awaiting admission) or start (profile_pending)
 *   profile_pending -> complete_vendor_business_profile -> stripe_pending
 *   stripe_pending -> Stripe link + status check + confirm -> waiver_pending
 *   waiver_pending -> sign agreement -> admin_review -> (Splitt approves) active
 */
import { z } from 'zod';
import { defineTool, ok, fail, fromResult } from '../registry';
import { vendorOnboardingApi, onboardingNextStep, type OnboardingStatusView } from '../vendor-onboarding';
import { uuid, READ, WRITE, WRITE_IDEMPOTENT, token } from './common';

const PIPELINE =
  'Become-a-vendor pipeline, in order: apply_to_become_vendor (or start_vendor_onboarding), complete_vendor_business_profile, ' +
  'start_vendor_stripe_onboarding then check_vendor_stripe_status then confirm_vendor_stripe, get_vendor_agreement then sign_vendor_agreement, ' +
  'then Splitt reviews and activates the account. get_vendor_onboarding_status shows the current step at any time.';

function withNextStep(view: OnboardingStatusView | null | undefined) {
  return { ...(view ?? {}), nextStep: onboardingNextStep(view?.status) };
}

export const applyToBecomeVendor = defineTool({
  name: 'apply_to_become_vendor',
  title: 'Apply as vendor',
  description:
    'Step 1 of becoming a Splitt vendor: file a vendor application on the signed-in renter\'s own account (no new account is created; email and password are never sent). ' +
    'Without an invite token the application waits for Splitt admission (status "applied"); a valid invite token admits immediately (status "profile_pending") and unlocks the wizard. ' +
    'Fails if the user is already a vendor or already has an application in progress. Returns the resulting status, whether it was admitted, and the next step. ' +
    PIPELINE,
  access: 'user',
  scope: 'profile',
  inputSchema: {
    businessName: z.string().min(1).max(120).optional().describe('Storefront / business name (saved as the store name; can be refined later in the profile step).'),
    businessInterest: z.string().min(1).max(1000).optional().describe('Free text: what gear or services the user wants to list. Shown to the Splitt team reviewing the application.'),
    inviteToken: z.string().min(1).max(500).optional().describe('Invite token from a Splitt partner invitation link (?invite=...). Skips admission.'),
  },
  annotations: WRITE,
  handler: async (args, ctx) =>
    fromResult(await vendorOnboardingApi.apply(token(ctx), args), (d) => ({
      status: d?.status,
      admitted: d?.admitted,
      user: d?.user,
      nextStep: onboardingNextStep(d?.status),
    })),
});

export const startVendorOnboarding = defineTool({
  name: 'start_vendor_onboarding',
  title: 'Start vendor onboarding',
  description:
    'Begin the self-service vendor onboarding wizard, or restart it after a rejection: moves the signed-in renter from not_started / rejected to profile_pending so complete_vendor_business_profile can be called. ' +
    'Idempotent while onboarding is already in progress (returns the current status); fails if the user is already a vendor. ' +
    'Prefer apply_to_become_vendor when the user has an invite token or wants to describe their business to Splitt first. Returns the onboarding status view (steps, readyForReview) plus the next step.',
  access: 'user',
  scope: 'profile',
  inputSchema: {},
  annotations: WRITE_IDEMPOTENT,
  handler: async (_args, ctx) => fromResult(await vendorOnboardingApi.start(token(ctx)), withNextStep),
});

export const completeVendorBusinessProfile = defineTool({
  name: 'complete_vendor_business_profile',
  title: 'Vendor business profile',
  description:
    'Step 2 of becoming a vendor: save the storefront details renters will see (store name, business phone, business address, store description of at least 20 characters). ' +
    'All four fields are required; re-sending overwrites them. Advances profile_pending to stripe_pending. ' +
    'Requires an admitted application (status profile_pending or later; not_started, applied and active are refused). Returns the updated onboarding status and the next step.',
  access: 'user',
  scope: 'profile',
  inputSchema: {
    storeName: z.string().min(1).max(120).describe('Public storefront name.'),
    businessPhone: z.string().min(1).max(40).describe('Business contact phone.'),
    businessAddress: z.string().min(1).max(300).describe('Business address (street, city, state).'),
    storeDescription: z.string().min(20).max(2000).describe('Public description of the store and what it rents; at least 20 characters.'),
  },
  annotations: WRITE_IDEMPOTENT,
  handler: async (args, ctx) => {
    const input = {
      storeName: args.storeName.trim(),
      businessPhone: args.businessPhone.trim(),
      businessAddress: args.businessAddress.trim(),
      storeDescription: args.storeDescription.trim(),
    };
    if (!input.storeName || !input.businessPhone || !input.businessAddress) return fail('storeName, businessPhone and businessAddress must not be blank.');
    if (input.storeDescription.length < 20) return fail('storeDescription must be at least 20 characters.');
    return fromResult(await vendorOnboardingApi.completeProfile(token(ctx), input), withNextStep);
  },
});

export const startVendorStripeOnboarding = defineTool({
  name: 'start_vendor_stripe_onboarding',
  title: 'Set up vendor payouts',
  description:
    'Step 3 of becoming a vendor: create (or reuse) the applicant\'s Stripe Connect payout account and return a Stripe-hosted onboarding URL. ' +
    'Give onboardingUrl to the user to open in a browser; bank and identity details are entered on Stripe only (never collect them yourself). ' +
    'When they are done, call check_vendor_stripe_status and then confirm_vendor_stripe. Safe to call again to get a fresh link if the previous one expired. ' +
    'This is the in-pipeline version for applicants who are not vendors yet; active vendor owners use start_stripe_connect_onboarding.',
  access: 'user',
  scope: 'profile',
  inputSchema: {},
  annotations: WRITE_IDEMPOTENT,
  handler: async (_args, ctx) =>
    fromResult(await vendorOnboardingApi.startStripeConnect(token(ctx)), (d) => ({
      onboardingUrl: d?.url,
      accountId: d?.accountId,
      nextStep: 'Have the user open onboardingUrl and finish on Stripe, then call check_vendor_stripe_status; once it reports status "enabled", call confirm_vendor_stripe.',
    })),
});

export const checkVendorStripeStatus = defineTool({
  name: 'check_vendor_stripe_status',
  title: 'Check Stripe status',
  description:
    'Refresh and return the applicant\'s Stripe Connect payout account state during onboarding: connected, status (not_connected / pending / restricted / enabled / error), chargesEnabled, payoutsEnabled and any outstanding Stripe requirements. ' +
    'Use it after the user finishes on Stripe (it may take a minute to become "enabled"); when status is "enabled", call confirm_vendor_stripe. Requires an in-progress application.',
  access: 'user',
  scope: 'profile',
  inputSchema: {},
  annotations: READ,
  handler: async (_args, ctx) =>
    fromResult(await vendorOnboardingApi.getStripeStatus(token(ctx)), (d) => ({
      ...(d ?? {}),
      nextStep:
        d?.status === 'enabled'
          ? 'Stripe is enabled: call confirm_vendor_stripe to advance to the agreement step.'
          : d?.status === 'not_connected'
            ? 'No Stripe account yet: call start_vendor_stripe_onboarding.'
            : 'Stripe has not finished enabling the account (or still needs information). Re-open the link from start_vendor_stripe_onboarding, then check again.',
    })),
});

export const confirmVendorStripe = defineTool({
  name: 'confirm_vendor_stripe',
  title: 'Confirm Stripe step',
  description:
    'Complete the Stripe step of vendor onboarding once check_vendor_stripe_status reports "enabled": Splitt re-verifies the live account and advances stripe_pending to waiver_pending. ' +
    'Fails with a clear message while the Stripe account is not yet enabled (finish on Stripe first). Idempotent once advanced. Returns the updated onboarding status and the next step.',
  access: 'user',
  scope: 'profile',
  inputSchema: {},
  annotations: WRITE_IDEMPOTENT,
  handler: async (_args, ctx) => fromResult(await vendorOnboardingApi.confirmStripe(token(ctx)), withNextStep),
});

export const getVendorAgreement = defineTool({
  name: 'get_vendor_agreement',
  title: 'Vendor agreement',
  description:
    'Step 4 of becoming a vendor: fetch the current Splitt vendor liability agreement (id, name, version and the full terms as HTML) that the applicant must sign. ' +
    'Show the terms to the user and ask for their explicit agreement before calling sign_vendor_agreement with the returned waiverId and waiverVersion. ' +
    'Returns available=false when no agreement is configured (signing is then unavailable; try again later).',
  access: 'user',
  scope: 'profile',
  inputSchema: {},
  annotations: READ,
  handler: async (_args, ctx) =>
    fromResult(await vendorOnboardingApi.getWaiver(token(ctx)), (waiver) =>
      waiver && typeof waiver.content === 'string' && waiver.content.trim()
        ? {
            available: true,
            waiverId: waiver.id,
            waiverVersion: waiver.version,
            name: waiver.name,
            content: waiver.content,
            nextStep: 'Present these terms to the user. Only when they explicitly agree and type their full legal name, call sign_vendor_agreement with that name plus this waiverId and waiverVersion.',
          }
        : { available: false, message: 'No active vendor agreement is configured right now; signing is unavailable. Try again later or contact Splitt.' },
    ),
});

export const signVendorAgreement = defineTool({
  name: 'sign_vendor_agreement',
  title: 'Sign vendor agreement',
  description:
    'LEGALLY BINDING: record the applicant\'s electronic signature on the Splitt vendor liability agreement (signature, timestamp, IP and device are kept as the legal record). ' +
    'Only call this after get_vendor_agreement, after the user has read the terms, explicitly agreed, and typed their own full legal name; never invent, guess or auto-fill the signature. ' +
    'Pass waiverId and waiverVersion from get_vendor_agreement so the signature binds to the exact terms shown; if the agreement changed in the meantime Splitt refuses (409) and you must re-fetch and re-present it. ' +
    'Advances waiver_pending to admin_review; a repeat call after signing is a no-op. Splitt then reviews and activates the vendor account (the user signs in again for the vendor role to take effect).',
  access: 'user',
  scope: 'profile',
  inputSchema: {
    signature: z.string().min(1).max(200).describe('The user\'s typed full legal name, exactly as they typed it.'),
    waiverId: uuid('vendor agreement').optional().describe('waiverId from get_vendor_agreement (strongly recommended).'),
    waiverVersion: z.number().int().min(1).optional().describe('waiverVersion from get_vendor_agreement (strongly recommended).'),
  },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ signature, waiverId, waiverVersion }, ctx) => {
    const typed = signature.trim();
    if (!typed) return fail('signature must be the user\'s typed full legal name.');
    const result = await vendorOnboardingApi.signWaiver(token(ctx), { signature: typed, waiverId, waiverVersion });
    if (!result.ok) return fromResult(result);
    return ok({ ...withNextStep(result.data), signed: true });
  },
});

export const vendorOnboardingTools = [
  applyToBecomeVendor,
  startVendorOnboarding,
  completeVendorBusinessProfile,
  startVendorStripeOnboarding,
  checkVendorStripeStatus,
  confirmVendorStripe,
  getVendorAgreement,
  signVendorAgreement,
];
