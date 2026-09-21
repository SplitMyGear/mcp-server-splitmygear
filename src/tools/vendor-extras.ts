/**
 * Vendor settings, money details, listing promotions and trust: thin clients
 * of the backend's `/vendor`, `/payments` and `/trust` routes that the core
 * vendor module does not cover (auto-approve, report subscription, tax
 * summary, payout details / statements, payout requests, sponsored listings,
 * transaction history, trust scores and booking risk).
 *
 * Every call forwards the caller's own JWT; the backend's VendorRoleGuard /
 * RolesGuard decide which seat may do what (owner-only payout requests,
 * owner/manager finance reads, vendor-family settings). Only DTO fields are
 * ever sent (the backend's global ValidationPipe rejects undeclared fields
 * with a 400), and every path segment is a UUID validated by the tool schema.
 */
import { call, compact, qs, type Result } from './_shared';

/** `ReportFrequency` of the user entity: how often the vendor report email goes out. */
export const REPORT_FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly', 'annual', 'none'] as const;
export type ReportFrequency = (typeof REPORT_FREQUENCIES)[number];

/** `ReportType` of the user entity: which sections the vendor report email carries. */
export const REPORT_TYPES = ['revenue', 'bookings', 'payouts', 'listings', 'all'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

/** `SponsorTier` of the listing entity: the paid promotion packages. */
export const SPONSOR_TIERS = ['STARTER', 'FEATURED', 'PREMIUM'] as const;
export type SponsorTier = (typeof SPONSOR_TIERS)[number];

export interface ReportSubscriptionInput {
  frequency?: ReportFrequency;
  subscribedTypes?: ReportType[];
}

export interface TaxSummaryQuery {
  year?: number;
  /** `csv` returns `{ csv, filename }` instead of the JSON summary. */
  format?: 'csv';
}

export interface RequestPayoutInput {
  /** Omit to withdraw the full withdrawable balance. */
  amount?: number;
  description?: string;
}

export interface PromotionCheckout {
  success?: boolean;
  sessionId?: string;
  checkoutUrl?: string;
}

export const vendorExtrasApi = {
  // ── Vendor settings ──────────────────────────────────────────────────────

  /** Account-level auto-approve: sets the vendor default and bulk-applies instantBook to every owned listing. */
  setAutoApprove(token: string, enabled: boolean) {
    return call('PATCH', '/vendor/auto-approve', { token, body: { enabled } });
  },

  getReportSubscription(token: string) {
    return call('GET', '/vendor/report-subscription', { token });
  },

  updateReportSubscription(token: string, input: ReportSubscriptionInput) {
    return call('POST', '/vendor/report-subscription', { token, body: compact(input) });
  },

  // ── Money details ────────────────────────────────────────────────────────

  getTaxSummary(token: string, query: TaxSummaryQuery = {}) {
    return call('GET', `/vendor/tax-summary${qs({ year: query.year, format: query.format })}`, { token });
  },

  getPayoutDetails(token: string, payoutId: string) {
    return call('GET', `/vendor/payouts/${payoutId}`, { token });
  },

  /** Itemized statement: the bookings a payout settled with per-booking gross / platform fee / net plus totals. */
  getPayoutStatement(token: string, payoutId: string) {
    return call('GET', `/vendor/payouts/${payoutId}/statement`, { token });
  },

  /** Payout details plus its statement in one round trip; a statement failure is reported, not fatal. */
  async getPayoutWithStatement(token: string, payoutId: string): Promise<Result<{ payout: unknown; statement: unknown; errors: string[] }>> {
    const [details, statement] = await Promise.all([this.getPayoutDetails(token, payoutId), this.getPayoutStatement(token, payoutId)]);
    if (!details.ok) return details;
    return {
      ok: true,
      data: {
        payout: details.data,
        statement: statement.ok ? statement.data : null,
        errors: statement.ok ? [] : [`statement: ${statement.error}`],
      },
    };
  },

  /** Owner-only money move: transfers the withdrawable balance (or `amount`) to the vendor's Stripe Connect account. */
  requestPayout(token: string, input: RequestPayoutInput = {}) {
    return call('POST', '/vendor/payouts', { token, body: compact(input) });
  },

  // ── Sponsored listings ───────────────────────────────────────────────────

  listSponsorshipPackages(token: string) {
    return call('GET', '/payments/sponsorship-packages', { token });
  },

  listListingPromotions(token: string, listingId: string) {
    return call('GET', `/payments/listings/${listingId}/promotions`, { token });
  },

  /** Opens Stripe Checkout for a promotion; the backend picks safe success / cancel URLs, so only `tier` is sent. */
  promoteListing(token: string, listingId: string, tier: SponsorTier) {
    return call<PromotionCheckout>('POST', `/payments/listings/${listingId}/promote`, { token, body: { tier } });
  },

  // ── Transactions ─────────────────────────────────────────────────────────

  listTransactions(token: string) {
    return call('GET', '/payments/transactions', { token });
  },

  getTransaction(token: string, transactionId: string) {
    return call('GET', `/payments/transactions/${transactionId}`, { token });
  },

  // ── Trust ────────────────────────────────────────────────────────────────

  getMyTrustScore(token: string) {
    return call('GET', '/trust/my-score', { token });
  },

  refreshMyTrustScore(token: string) {
    return call('POST', '/trust/refresh-score', { token, body: {} });
  },

  getBookingRisk(token: string, bookingId: string) {
    return call('GET', `/trust/booking/${bookingId}/risk`, { token });
  },
};
