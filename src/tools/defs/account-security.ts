/**
 * Account security + preferences tools (signed-in user, scope `profile`):
 * security status, sign out everywhere, data export, notification + email
 * preference centres, Terms of Service, email verification, KYC state.
 *
 * Anything that needs a password or one-time code typed by the user (account
 * deletion, password change, 2FA enrol/disable, passkeys, KYC document upload)
 * stays in the Splitt web UI on purpose and is not exposed here.
 */
import { z } from 'zod';
import { defineTool, fail, fromResult } from '../registry';
import { accountSecurityTools as backend, NOTIFICATION_CATEGORIES } from '../account-security';
import { READ, WRITE, WRITE_IDEMPOTENT, DESTRUCTIVE, token } from './common';

const SETTINGS_URL = 'https://go-splitt.com/profile';

// ── Security ─────────────────────────────────────────────────────────────────

export const getSecurityStatus = defineTool({
  name: 'get_security_status',
  title: 'Security status',
  description:
    'Security overview of the signed-in Splitt account: whether two-step verification (2FA) is on, when it was enrolled, any registered passkeys ' +
    '(name, device type, last used), and the list of active sessions (device/user agent, IP, created and expiry times). ' +
    'Use it to answer "is 2FA on?", "which devices am I signed in on?" or before sign_out_all_sessions. Read-only. ' +
    `Turning 2FA on/off and adding passkeys need the account password typed in the Splitt UI (${SETTINGS_URL}); this tool cannot do that.`,
  access: 'user',
  scope: 'profile',
  inputSchema: {},
  annotations: READ,
  handler: async (_args, ctx) => fromResult(await backend.getSecurityStatus(token(ctx))),
});

export const signOutAllSessions = defineTool({
  name: 'sign_out_all_sessions',
  title: 'Sign out everywhere',
  description:
    'Sign the user out of EVERY device and app by revoking all of their Splitt refresh tokens: web, mobile, and this MCP connection too ' +
    '(this connection stops working within about 15 minutes when its access token expires; the user must sign in again). ' +
    'Use it when the user suspects their account is being used elsewhere or lost a device. DESTRUCTIVE: always confirm with the user first, ' +
    'and suggest get_security_status to review sessions before revoking. Returns a confirmation message.',
  access: 'user',
  scope: 'profile',
  inputSchema: {},
  annotations: DESTRUCTIVE,
  handler: async (_args, ctx) =>
    fromResult(await backend.signOutAllSessions(token(ctx)), (data) => ({
      signedOutEverywhere: true,
      message: data?.message ?? 'All sessions revoked',
      note: 'This MCP connection will stop working once its current access token expires; sign in again to continue.',
    })),
});

// ── Privacy / data export ────────────────────────────────────────────────────

export const exportMyData = defineTool({
  name: 'export_my_data',
  title: 'Export my data',
  description:
    'Download the signed-in user\'s own personal data as JSON (GDPR/CCPA data portability): profile, bookings, reviews, favorites, saved searches, ' +
    'notifications, connections, transactions, vendor listings/bookings/payouts, own chat messages + conversation ids, KYC status, consent history, ' +
    'and up to 13 months of web analytics (sessions, page views, clicks, searches; up to 1000 rows each). ' +
    'The full payload can be LARGE (often hundreds of KB to a few MB for active accounts). Call with summaryOnly=true first to get per-section ' +
    'row counts and approximate sizes, then request only the sections you need. Rate limited to 3 calls per minute. Read-only; nothing is deleted or changed.',
  access: 'user',
  scope: 'profile',
  inputSchema: {
    summaryOnly: z.boolean().optional().describe('If true, return only counts and approximate byte sizes per section (recommended first call).'),
    sections: z
      .array(z.string().min(1).max(60))
      .max(40)
      .optional()
      .describe('Top-level sections to include, e.g. ["profile","bookings","consent"]. Omit for everything. Section names come from summaryOnly.availableSections.'),
  },
  annotations: READ,
  handler: async ({ summaryOnly, sections }, ctx) => fromResult(await backend.exportMyData(token(ctx), { summaryOnly, sections })),
});

// ── Preference centres ───────────────────────────────────────────────────────

export const getNotificationPreferences = defineTool({
  name: 'get_notification_preferences',
  title: 'Notification preferences',
  description:
    'The signed-in user\'s notification preference centre: for each optional category (BOOKING_REMINDER, REVIEW_REQUEST, LISTING_INQUIRY, PRICE_ALERT, NEW_MESSAGE) ' +
    'whether email, in-app and push delivery are enabled (all default to on). Transactional notices such as booking confirmations, password resets and ' +
    'account security emails are never listed because they cannot be muted. Read-only; change a category with set_notification_preference.',
  access: 'user',
  scope: 'profile',
  inputSchema: {},
  annotations: READ,
  handler: async (_args, ctx) => fromResult(await backend.getNotificationPreferences(token(ctx))),
});

export const setNotificationPreference = defineTool({
  name: 'set_notification_preference',
  title: 'Set notification preference',
  description:
    'Turn email, in-app or push delivery on/off for ONE optional notification category of the signed-in user. Only the channel flags you pass are changed; ' +
    'the others keep their current value. Categories: BOOKING_REMINDER (pickup/return reminders), REVIEW_REQUEST, LISTING_INQUIRY, PRICE_ALERT (price drops, ' +
    'saved-search alerts), NEW_MESSAGE (the "new chat message" email only; the in-app bell always shows). Returns the resulting flags for that category. ' +
    'Idempotent; safe to repeat.',
  access: 'user',
  scope: 'profile',
  inputSchema: {
    category: z.enum(NOTIFICATION_CATEGORIES).describe('Which notification category to change.'),
    emailEnabled: z.boolean().optional().describe('Receive this category by email.'),
    inAppEnabled: z.boolean().optional().describe('Show this category in the in-app notification list.'),
    pushEnabled: z.boolean().optional().describe('Receive this category as a mobile push notification.'),
  },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ category, emailEnabled, inAppEnabled, pushEnabled }, ctx) => {
    if (emailEnabled === undefined && inAppEnabled === undefined && pushEnabled === undefined) {
      return fail('Pass at least one of emailEnabled, inAppEnabled or pushEnabled.');
    }
    return fromResult(await backend.setNotificationPreference(token(ctx), { category, emailEnabled, inAppEnabled, pushEnabled }));
  },
});

export const getEmailPreferences = defineTool({
  name: 'get_email_preferences',
  title: 'Email preferences',
  description:
    'The signed-in user\'s email subscription settings: marketingEmails (promotions, seasonal campaigns), productUpdateEmails (new features), ' +
    'profilingOptOut (stop Splitt building a personalised interest profile from browsing), plus the opt-out timestamps. ' +
    'Read-only; change them with set_email_preferences. Transactional emails (bookings, receipts, security) are not affected by these settings.',
  access: 'user',
  scope: 'profile',
  inputSchema: {},
  annotations: READ,
  handler: async (_args, ctx) => fromResult(await backend.getEmailPreferences(token(ctx))),
});

export const setEmailPreferences = defineTool({
  name: 'set_email_preferences',
  title: 'Set email preferences',
  description:
    'Update the signed-in user\'s email subscriptions. Only the fields you pass are changed. marketingEmails=false unsubscribes from promotional mail ' +
    '(also mirrored to Splitt\'s CRM); productUpdateEmails controls feature announcements; profilingOptOut=true stops personalisation from browsing ' +
    'and immediately clears the browsing-derived interest profile. Transactional emails cannot be turned off here. Returns the resulting preferences. Idempotent.',
  access: 'user',
  scope: 'profile',
  inputSchema: {
    marketingEmails: z.boolean().optional().describe('Receive promotional and seasonal marketing emails.'),
    productUpdateEmails: z.boolean().optional().describe('Receive product update / new feature emails.'),
    profilingOptOut: z.boolean().optional().describe('true = opt OUT of browsing-based personalisation; false = opt back in.'),
  },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ marketingEmails, productUpdateEmails, profilingOptOut }, ctx) => {
    if (marketingEmails === undefined && productUpdateEmails === undefined && profilingOptOut === undefined) {
      return fail('Pass at least one of marketingEmails, productUpdateEmails or profilingOptOut.');
    }
    return fromResult(await backend.setEmailPreferences(token(ctx), { marketingEmails, productUpdateEmails, profilingOptOut }));
  },
});

// ── Terms of Service + email verification ────────────────────────────────────

export const getTermsStatus = defineTool({
  name: 'get_terms_status',
  title: 'Terms of Service status',
  description:
    'Whether the signed-in user has accepted the CURRENT Splitt Terms of Service: currentVersion, acceptedVersion, acceptedAt and needsReacceptance ' +
    '(true when the terms changed since they last agreed, or they never recorded acceptance). Use it when a booking or vendor action is blocked by a ' +
    'terms banner, or before calling accept_terms. Read-only.',
  access: 'user',
  scope: 'profile',
  inputSchema: {},
  annotations: READ,
  handler: async (_args, ctx) => fromResult(await backend.getTermsStatus(token(ctx))),
});

export const acceptTerms = defineTool({
  name: 'accept_terms',
  title: 'Accept Terms of Service',
  description:
    'Record the signed-in user\'s acceptance of the CURRENT Splitt Terms of Service (https://go-splitt.com/terms). This is a legal assent recorded with ' +
    'the version, time, IP and client, and it is audited. Only call it after the user has explicitly said they agree to the current terms; never ' +
    'accept on their behalf silently. Check get_terms_status first; calling when nothing is owed is harmless and just re-stamps the same version. ' +
    'Returns the updated terms status.',
  access: 'user',
  scope: 'profile',
  inputSchema: {},
  annotations: WRITE_IDEMPOTENT,
  handler: async (_args, ctx) => fromResult(await backend.acceptTerms(token(ctx))),
});

export const resendVerificationEmail = defineTool({
  name: 'resend_verification_email',
  title: 'Resend verification email',
  description:
    'Send the signed-in user a fresh email-address verification link (for accounts that have not confirmed their email yet). The reply is deliberately ' +
    'generic and identical whether or not the address still needed verifying, so do not infer status from it; use get_my_profile for isEmailVerified. ' +
    'Limited to 5 sends per 10 minutes per account. Use when the user says they never got, or lost, the verification email.',
  access: 'user',
  scope: 'profile',
  inputSchema: {},
  annotations: WRITE,
  handler: async (_args, ctx) => fromResult(await backend.resendVerificationEmail(token(ctx))),
});

// ── Identity verification (KYC), read-only ───────────────────────────────────

export const getIdentityVerificationStatus = defineTool({
  name: 'get_identity_verification_status',
  title: 'Identity verification status',
  description:
    'Read-only KYC state for the signed-in user. status: verified (true only with a VERIFIED driver\'s license, the sole identity requirement), idVerified, ' +
    'biometricVerified (optional selfie), pending, and a short list of submitted documents. verifications: per-document detail (type DRIVERS_LICENSE / ' +
    'INSURANCE / BOATER_LICENSE / BIOMETRIC_LIVENESS, status PENDING_REVIEW / VERIFIED / REJECTED / NEEDS_MORE_INFO / LIVENESS_FAILED, rejectionReason, ' +
    'documentExpiry, reviewedAt). Use it when a booking says ID verification is required or to explain a rejection. ' +
    'Uploading or re-submitting a document is out of scope here: it is a browser upload flow at https://go-splitt.com/verification.',
  access: 'user',
  scope: 'profile',
  inputSchema: {},
  annotations: READ,
  handler: async (_args, ctx) => fromResult(await backend.getIdentityVerificationStatus(token(ctx))),
});

export const accountSecurityTools = [
  getSecurityStatus,
  signOutAllSessions,
  exportMyData,
  getNotificationPreferences,
  setNotificationPreference,
  getEmailPreferences,
  setEmailPreferences,
  getTermsStatus,
  acceptTerms,
  resendVerificationEmail,
  getIdentityVerificationStatus,
];
