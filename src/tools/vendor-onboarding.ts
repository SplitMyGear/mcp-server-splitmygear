/**
 * Become-a-vendor onboarding: thin clients of the SELF-SERVICE
 * `/vendor-onboarding/*` routes (backend SPLIT-260 / SPLIT-326). The applicant
 * is still a renter while in the pipeline, so these routes are JWT-only (no
 * vendor role guard) and the backend derives the applicant from the forwarded
 * token; no user id is ever accepted from the caller.
 *
 * Only DTO-declared fields are sent (the backend's global ValidationPipe has
 * forbidNonWhitelisted, so anything else is a 400):
 *   - POST /apply sends ONLY businessName / businessInterest / inviteToken. The
 *     anonymous-signup fields (email, password, firstName, lastName) and the
 *     honeypot (website) are never sent: a signed-in renter upgrades their own
 *     account.
 *   - POST /profile sends the four CompleteVendorProfileDto fields.
 *   - POST /waiver sends SignVendorWaiverDto (signature + optional id/version).
 *
 * Staff routes (GET /applications, POST /invites, POST /:id/*) are deliberately
 * not wrapped. GET /status already lives in `accountTools`.
 */
import { call, compact } from './_shared';

/** `VendorOnboardingStatus` on the backend user entity. */
export const VENDOR_ONBOARDING_STATUSES = [
  'not_started',
  'applied',
  'profile_pending',
  'stripe_pending',
  'waiver_pending',
  'admin_review',
  'active',
  'rejected',
] as const;
export type VendorOnboardingStatus = (typeof VENDOR_ONBOARDING_STATUSES)[number];

export interface VendorApplicationInput {
  businessName?: string;
  businessInterest?: string;
  inviteToken?: string;
}

export interface VendorProfileInput {
  storeName: string;
  businessPhone: string;
  businessAddress: string;
  storeDescription: string;
}

export interface VendorWaiverSignature {
  signature: string;
  waiverId?: string;
  waiverVersion?: number;
}

/** The backend's OnboardingStatusView (loosely typed; the backend owns the shape). */
export interface OnboardingStatusView {
  userId?: string;
  email?: string;
  storeName?: string | null;
  role?: string;
  status?: string;
  updatedAt?: string | null;
  steps?: Array<{ key: string; label: string; complete: boolean; detail?: string }>;
  readyForReview?: boolean;
}

export interface VendorApplyResponse {
  status?: string;
  admitted?: boolean;
  user?: { id: string; email: string; role: string; firstName: string; lastName: string; vendorOnboardingStatus: string };
}

export interface OnboardingStripeStatus {
  connected?: boolean;
  status?: string;
  chargesEnabled?: boolean;
  payoutsEnabled?: boolean;
  requirements?: unknown;
  error?: string;
}

export interface VendorWaiver {
  id: string;
  name: string;
  content: string;
  version: number;
}

/** What the model should do next for a given pipeline status (mirrors the backend state machine). */
export function onboardingNextStep(status: string | null | undefined): string {
  switch (status) {
    case 'not_started':
      return 'Begin with apply_to_become_vendor (pass the invite token if the user has one) or start_vendor_onboarding.';
    case 'applied':
      return 'Application filed; Splitt must admit it before the wizard unlocks. Check back with get_vendor_onboarding_status.';
    case 'profile_pending':
      return 'Call complete_vendor_business_profile with the storefront name, business phone, business address and description.';
    case 'stripe_pending':
      return 'Call start_vendor_stripe_onboarding, have the user finish on Stripe, then check_vendor_stripe_status and confirm_vendor_stripe.';
    case 'waiver_pending':
      return 'Call get_vendor_agreement, show the user the terms, then sign_vendor_agreement once they explicitly agree.';
    case 'admin_review':
      return 'All steps are complete; Splitt is reviewing the application. Nothing more to do until approval.';
    case 'active':
      return 'The vendor account is active. If vendor tools are not visible yet, the user must sign in again so the new role is issued.';
    case 'rejected':
      return 'The application was rejected. start_vendor_onboarding (or apply_to_become_vendor) restarts it.';
    default:
      return 'Call get_vendor_onboarding_status to see the current step.';
  }
}

export const vendorOnboardingApi = {
  /** Signed-in renter files a vendor application on their own account (201). */
  apply(token: string, input: VendorApplicationInput) {
    return call<VendorApplyResponse>('POST', '/vendor-onboarding/apply', { token, body: compact(input) });
  },

  /** not_started / rejected -> profile_pending; a no-op while already in progress. */
  start(token: string) {
    return call<OnboardingStatusView>('POST', '/vendor-onboarding/start', { token, body: {} });
  },

  /** Saves the storefront fields; profile_pending -> stripe_pending. */
  completeProfile(token: string, input: VendorProfileInput) {
    return call<OnboardingStatusView>('POST', '/vendor-onboarding/profile', { token, body: compact(input) });
  },

  /** Creates or reuses the applicant's Stripe Express account; returns `{ url, accountId }`. */
  startStripeConnect(token: string) {
    return call<{ url?: string; accountId?: string }>('POST', '/vendor-onboarding/stripe/connect', { token, body: {} });
  },

  /** Live Stripe account state (the backend refreshes it from Stripe and caches it). */
  getStripeStatus(token: string) {
    return call<OnboardingStripeStatus>('GET', '/vendor-onboarding/stripe/status', { token });
  },

  /** stripe_pending -> waiver_pending once the Stripe account is enabled (400 otherwise). */
  confirmStripe(token: string) {
    return call<OnboardingStatusView>('POST', '/vendor-onboarding/confirm-stripe', { token, body: {} });
  },

  /** The active vendor liability agreement, or null when none is configured. */
  getWaiver(token: string) {
    return call<VendorWaiver | null>('GET', '/vendor-onboarding/waiver', { token });
  },

  /** Records the typed signature as the legal record; waiver_pending -> admin_review. */
  signWaiver(token: string, input: VendorWaiverSignature) {
    return call<OnboardingStatusView>('POST', '/vendor-onboarding/waiver', { token, body: compact(input) });
  },
};
