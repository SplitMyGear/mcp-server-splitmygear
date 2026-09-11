/**
 * Vendor extras: account settings (auto-approve, report emails), money details
 * (tax summary, payout details / statements, payout requests), sponsored
 * listing promotions, transaction history and trust (own score, booking risk).
 * Access mirrors the backend guards: owner-only payout requests, owner/manager
 * finance reads, vendor family for settings and promotions, any signed-in user
 * for transactions and their own trust score.
 */
import { z } from 'zod';
import { defineTool, fail, fromResult } from '../registry';
import { vendorExtrasApi, REPORT_FREQUENCIES, REPORT_TYPES, SPONSOR_TIERS } from '../vendor-extras';
import { uuid, READ, WRITE, WRITE_IDEMPOTENT, DESTRUCTIVE, token } from './common';

const STAFF_NOTE = 'Account-level setting shared by every seat of the vendor account (owner, manager and staff seats may all change it).';

// ── Vendor settings ──────────────────────────────────────────────────────────

export const setAutoApprove = defineTool({
  name: 'set_auto_approve',
  title: 'Auto-approve bookings',
  description:
    'Turn account-level auto-approve on or off for the signed-in vendor. enabled=true sets the vendor default AND switches instantBook on for EVERY listing the ' +
    'vendor owns, so new booking requests are confirmed automatically; enabled=false reverses both and requests wait for manual acceptance. Returns ' +
    'autoApproveBookings and listingsUpdated. This changes the whole fleet at once, so confirm with the user first; use update_listing(instantBook) for a single listing. ' +
    STAFF_NOTE,
  access: 'vendor',
  scope: 'vendor_bookings',
  inputSchema: { enabled: z.boolean().describe('true: auto-confirm new bookings on all listings; false: require manual acceptance.') },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ enabled }, ctx) => fromResult(await vendorExtrasApi.setAutoApprove(token(ctx), enabled)),
});

export const getReportSubscription = defineTool({
  name: 'get_report_subscription',
  title: 'Report email settings',
  description:
    'The signed-in vendor\'s scheduled report email preferences: frequency (daily, weekly, monthly, quarterly, annual, none), the subscribed report sections ' +
    '(revenue, bookings, payouts, listings, all) and the available options. Use set_report_subscription to change them. ' +
    STAFF_NOTE,
  access: 'vendor',
  scope: 'finance',
  inputSchema: {},
  annotations: READ,
  handler: async (_args, ctx) => fromResult(await vendorExtrasApi.getReportSubscription(token(ctx))),
});

export const setReportSubscription = defineTool({
  name: 'set_report_subscription',
  title: 'Set report emails',
  description:
    'Change how often the signed-in vendor receives the scheduled report email and which sections it contains. Only the fields you pass change; frequency ' +
    '"none" stops the emails. An empty subscribedTypes list falls back to "all". Returns the saved frequency and subscribedTypes. ' +
    STAFF_NOTE,
  access: 'vendor',
  scope: 'finance',
  inputSchema: {
    frequency: z.enum(REPORT_FREQUENCIES).optional().describe('How often the report email goes out; "none" turns it off.'),
    subscribedTypes: z.array(z.enum(REPORT_TYPES)).max(REPORT_TYPES.length).optional().describe('Report sections to include; "all" covers everything.'),
  },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ frequency, subscribedTypes }, ctx) => {
    if (frequency === undefined && subscribedTypes === undefined) return fail('Pass frequency and/or subscribedTypes.');
    return fromResult(await vendorExtrasApi.updateReportSubscription(token(ctx), { frequency, subscribedTypes }));
  },
});

// ── Money details ────────────────────────────────────────────────────────────

export const getTaxSummary = defineTool({
  name: 'get_tax_summary',
  title: 'Year-end tax summary',
  description:
    'On-demand year-end earnings summary for the signed-in vendor\'s tax filing: gross earnings, platform fees, net payout and transaction count for one ' +
    'calendar year (default: the current year; years before 2000 or after next year are rejected). format "csv" returns { csv, filename } for download instead ' +
    'of the JSON summary. Completed rental payments only. ' +
    STAFF_NOTE,
  access: 'vendor',
  scope: 'finance',
  inputSchema: {
    year: z.number().int().min(2000).max(2100).optional().describe('Calendar year, e.g. 2025 (default: current year).'),
    format: z.enum(['json', 'csv']).optional().describe('json (default) or csv.'),
  },
  annotations: READ,
  handler: async ({ year, format }, ctx) => {
    const maxYear = new Date().getFullYear() + 1;
    if (year !== undefined && year > maxYear) return fail(`year must be ${maxYear} or earlier.`);
    return fromResult(await vendorExtrasApi.getTaxSummary(token(ctx), { year, format: format === 'csv' ? 'csv' : undefined }));
  },
});

export const getPayoutDetails = defineTool({
  name: 'get_payout_details',
  title: 'Payout details',
  description:
    'One payout of the signed-in vendor (ids come from get_vendor_payouts): amount, fee, net amount, status (pending, processing, completed, failed, cancelled), ' +
    'description, failure reason and dates. By default also returns the itemized statement: the bookings this payout settled with per-booking gross, platform fee ' +
    'and net plus totals (statement.derived=true means a best-effort attribution for older payouts). Vendor owner seat only: the backend requires the payouts permission, which manager seats do not have.',
  access: 'vendor_finance',
  scope: 'finance',
  inputSchema: {
    payoutId: uuid('payout'),
    includeStatement: z.boolean().optional().describe('Also fetch the itemized statement (default true).'),
  },
  annotations: READ,
  handler: async ({ payoutId, includeStatement }, ctx) =>
    includeStatement === false
      ? fromResult(await vendorExtrasApi.getPayoutDetails(token(ctx), payoutId))
      : fromResult(await vendorExtrasApi.getPayoutWithStatement(token(ctx), payoutId)),
});

export const requestPayout = defineTool({
  name: 'request_payout',
  title: 'Request a payout',
  description:
    'Move money: transfer the signed-in vendor owner\'s withdrawable balance (or a smaller explicit amount) to their connected Stripe account. Check ' +
    'get_vendor_earnings first: only withdrawableBalance can be paid out (heldBalance is still inside the payout hold window) and Stripe Connect must be set up ' +
    '(get_stripe_connect_status). Returns the payout id, amount, net amount and status. This is irreversible; state the amount and get the user\'s explicit ' +
    'confirmation before calling. Vendor owner seat only.',
  access: 'vendor_owner',
  scope: 'finance',
  inputSchema: {
    amount: z.number().positive().max(1_000_000).multipleOf(0.01).optional().describe('USD amount (2 decimals). Omit to pay out the full withdrawable balance.'),
    description: z.string().max(500).optional().describe('Optional memo stored on the payout.'),
  },
  annotations: DESTRUCTIVE,
  handler: async ({ amount, description }, ctx) => fromResult(await vendorExtrasApi.requestPayout(token(ctx), { amount, description })),
});

// ── Sponsored listings ───────────────────────────────────────────────────────

export const listSponsorshipPackages = defineTool({
  name: 'list_sponsorship_packages',
  title: 'Promotion packages',
  description:
    'The paid listing promotion tiers a vendor can buy (STARTER, FEATURED, PREMIUM): price in USD, duration in days, badge shown on the listing card and search ' +
    'placement benefits. Use it to explain options before promote_listing.',
  access: 'vendor',
  scope: 'finance',
  inputSchema: {},
  annotations: READ,
  handler: async (_args, ctx) => fromResult(await vendorExtrasApi.listSponsorshipPackages(token(ctx))),
});

export const listListingPromotions = defineTool({
  name: 'list_listing_promotions',
  title: 'Listing promotions',
  description:
    'Current and past paid promotions of one listing the signed-in vendor owns, newest first: tier, amount, status (PENDING = checkout not completed, ACTIVE, ' +
    'EXPIRED, CANCELLED), start and end dates. Use it to see whether a listing is currently boosted before buying another promotion.',
  access: 'vendor',
  scope: 'finance',
  inputSchema: { listingId: uuid('listing') },
  annotations: READ,
  handler: async ({ listingId }, ctx) => fromResult(await vendorExtrasApi.listListingPromotions(token(ctx), listingId)),
});

export const promoteListing = defineTool({
  name: 'promote_listing',
  title: 'Promote a listing',
  description:
    'Start a paid promotion for one of the signed-in vendor\'s listings at the given tier (see list_sponsorship_packages for prices). Splitt records a PENDING ' +
    'promotion and returns checkoutUrl, a Stripe payment link the vendor must open in a browser to pay; the promotion only becomes ACTIVE after payment ' +
    '(never collect card details yourself). Retrying the same listing and tier reuses the pending checkout. Confirm the tier and price with the user before calling.',
  access: 'vendor',
  scope: 'finance',
  inputSchema: {
    listingId: uuid('listing'),
    tier: z.enum(SPONSOR_TIERS).describe('Promotion package to buy.'),
  },
  annotations: WRITE,
  handler: async ({ listingId, tier }, ctx) =>
    fromResult(await vendorExtrasApi.promoteListing(token(ctx), listingId, tier), (d) => ({
      checkoutUrl: d?.checkoutUrl,
      sessionId: d?.sessionId,
      tier,
      listingId,
      nextStep: 'Send the vendor to checkoutUrl to pay; the promotion activates automatically after payment. Check list_listing_promotions afterwards.',
    })),
});

// ── Transactions ─────────────────────────────────────────────────────────────

export const listMyTransactions = defineTool({
  name: 'list_my_transactions',
  title: 'My transactions',
  description:
    'Payment history of the signed-in user (renter or vendor): every transaction on their account with type (payment, refund, payout, deposit, deposit_release, ' +
    'deposit_claim, ...), amount, platform fee, tax amount, status (pending, processing, completed, failed, cancelled), description and date. Use get_transaction ' +
    'for the booking link and payout split of one row.',
  access: 'user',
  scope: 'finance',
  inputSchema: {},
  annotations: READ,
  handler: async (_args, ctx) => fromResult(await vendorExtrasApi.listTransactions(token(ctx))),
});

export const getTransaction = defineTool({
  name: 'get_transaction',
  title: 'Transaction details',
  description:
    'Full details of one transaction on the signed-in user\'s account: booking id, type, amount, platform fee, vendor payout, tax amount, status, description, ' +
    'failure reason, created and processed dates. Only the transaction\'s own user can read it.',
  access: 'user',
  scope: 'finance',
  inputSchema: { transactionId: uuid('transaction') },
  annotations: READ,
  handler: async ({ transactionId }, ctx) => fromResult(await vendorExtrasApi.getTransaction(token(ctx), transactionId)),
});

// ── Trust ────────────────────────────────────────────────────────────────────

export const getMyTrustScore = defineTool({
  name: 'get_my_trust_score',
  title: 'My trust score',
  description:
    'The signed-in user\'s own Splitt trust score (0-100), level, badge, the factors that raised or lowered it (email / ID verification, account age, completed ' +
    'bookings, reviews, cancellations, disputes) and any risk flags. Computed live; use refresh_my_trust_score to persist it to the profile.',
  access: 'user',
  scope: 'profile',
  inputSchema: {},
  annotations: READ,
  handler: async (_args, ctx) => fromResult(await vendorExtrasApi.getMyTrustScore(token(ctx))),
});

export const refreshMyTrustScore = defineTool({
  name: 'refresh_my_trust_score',
  title: 'Refresh my trust score',
  description:
    'Recalculate the signed-in user\'s trust score and save it to their profile (the value others see, for example after verifying ID or completing bookings). ' +
    'Returns the new score. Safe to repeat.',
  access: 'user',
  scope: 'profile',
  inputSchema: {},
  annotations: WRITE_IDEMPOTENT,
  handler: async (_args, ctx) => fromResult(await vendorExtrasApi.refreshMyTrustScore(token(ctx))),
});

export const getBookingRisk = defineTool({
  name: 'get_booking_risk',
  title: 'Booking risk check',
  description:
    'Risk assessment of one booking on the signed-in vendor\'s listings before accepting it: riskLevel (low, medium, high), the flags behind it (low renter trust ' +
    'score, high-value booking from a new account, far-future dates, renter not ID-verified) and a recommendation. Only a party to the booking can read it; an ' +
    'unknown booking id comes back as high risk with a "Booking not found" flag.',
  access: 'vendor',
  scope: 'vendor_bookings',
  inputSchema: { bookingId: uuid('booking') },
  annotations: READ,
  handler: async ({ bookingId }, ctx) => fromResult(await vendorExtrasApi.getBookingRisk(token(ctx), bookingId)),
});

export const vendorExtrasTools = [
  setAutoApprove,
  getReportSubscription,
  setReportSubscription,
  getTaxSummary,
  getPayoutDetails,
  requestPayout,
  listSponsorshipPackages,
  listListingPromotions,
  promoteListing,
  listMyTransactions,
  getTransaction,
  getMyTrustScore,
  refreshMyTrustScore,
  getBookingRisk,
];
