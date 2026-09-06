/**
 * Vendor pricing: seasonal rate rules (SPLIT-1284) and dynamic pricing.
 * Thin clients of the `/rentals/:id/rate-rules` family on the listing
 * controller and of `/dynamic-pricing/*`. The backend enforces ownership per
 * listing/rule and, for every MUTATION, the `change_pricing` vendor-seat
 * capability (SPLIT-1369): a `vendor_staff` seat gets a 403, reads stay open.
 *
 * Bodies carry ONLY DTO fields (CreateRateRuleDto / UpdateRateRuleDto /
 * ApplyStarterSeasonsDto / UpdateDynamicPricingConfigDto / ...): the backend's
 * global ValidationPipe rejects undeclared fields with a 400, so every body is
 * built with `compact()`. `null` is preserved on purpose: it is how a PATCH
 * clears a nullable rate-rule field.
 */
import { call, compact, qs } from './_shared';

export interface RateRuleInput {
  /** Vendor-facing label, max 80 chars. */
  name: string;
  /** Inclusive first night (ISO date). */
  startDate: string;
  /** EXCLUSIVE end: the first night the rule no longer applies to. */
  endDate: string;
  /** UTC weekdays 0 (Sun) to 6 (Sat); omit/null for every day in the range. */
  weekdayMask?: number[] | null;
  /** Absolute per-night rate in USD; mutually exclusive with ratePct. */
  nightlyRate?: number | null;
  /** Integer percentage adjustment (-90..500) of the base rate; mutually exclusive with nightlyRate. */
  ratePct?: number | null;
  /** Minimum nights when this date is the check-in night (1..90). */
  minNights?: number | null;
  /** Explicit override tier (0..1000, default 0). */
  priority?: number;
}

export type RateRuleUpdate = Partial<RateRuleInput>;

export interface StarterSeasonsInput {
  year: number;
  replaceExisting?: boolean;
}

export type AdjustmentSensitivity = 'low' | 'medium' | 'high';
export type AutoUpdateFrequency = 'daily' | 'weekly' | 'manual';

export interface DynamicPricingConfigInput {
  enabled?: boolean;
  autoUpdateEnabled?: boolean;
  minPrice?: number;
  maxPrice?: number;
  customBasePrice?: number;
  adjustmentSensitivity?: AdjustmentSensitivity;
  autoUpdateFrequency?: AutoUpdateFrequency;
  maxDailyAdjustment?: number;
  applyWeekendPremium?: boolean;
  applySeasonalPricing?: boolean;
  applyLengthDiscounts?: boolean;
  applyWeatherAdjustments?: boolean;
}

export const pricingRulesApi = {
  // ── Seasonal rate rules ─────────────────────────────────────────────────

  listRateRules(token: string, listingId: string) {
    return call('GET', `/rentals/${listingId}/rate-rules`, { token });
  },

  createRateRule(token: string, listingId: string, input: RateRuleInput) {
    return call('POST', `/rentals/${listingId}/rate-rules`, { token, body: compact(input) });
  },

  updateRateRule(token: string, ruleId: string, input: RateRuleUpdate) {
    return call('PATCH', `/rentals/rate-rules/${ruleId}`, { token, body: compact(input) });
  },

  /** 204 No Content on success (the Result data is undefined). */
  deleteRateRule(token: string, ruleId: string) {
    return call('DELETE', `/rentals/rate-rules/${ruleId}`, { token });
  },

  applyStarterSeasons(token: string, listingId: string, input: StarterSeasonsInput) {
    return call('POST', `/rentals/${listingId}/rate-rules/starter-seasons`, { token, body: compact(input) });
  },

  // ── Dynamic pricing ─────────────────────────────────────────────────────

  getDynamicPricingConfig(token: string, listingId: string) {
    return call('GET', `/dynamic-pricing/config/${listingId}`, { token });
  },

  setDynamicPricingConfig(token: string, listingId: string, input: DynamicPricingConfigInput) {
    return call('PUT', `/dynamic-pricing/config/${listingId}`, { token, body: compact(input) });
  },

  /** Suggested price for one date (defaults to today) and rental length in days (default 1). */
  calculatePrice(token: string, listingId: string, input: { date?: string; days?: number } = {}) {
    return call('GET', `/dynamic-pricing/calculate/${listingId}${qs({ date: input.date, days: input.days })}`, { token });
  },

  /** Suggested price aggregated over a whole date range. */
  calculatePriceRange(token: string, listingId: string, startDate: string, endDate: string) {
    return call('GET', `/dynamic-pricing/calculate/range/${listingId}${qs({ startDate, endDate })}`, { token });
  },

  getRecommendations(token: string, listingId: string, startDate?: string, endDate?: string) {
    return call('GET', `/dynamic-pricing/recommendations/${listingId}${qs({ startDate, endDate })}`, { token });
  },

  /** Generate (and store) fresh per-day recommendations for the next `days` days (1..90, default 30). */
  generateRecommendations(token: string, listingId: string, days?: number) {
    return call('POST', `/dynamic-pricing/recommendations/${listingId}`, { token, body: compact({ days }) });
  },

  /** Overwrite the listing's live base price with the suggestion for `date` (default today). */
  applySuggestedPrice(token: string, listingId: string, date?: string) {
    return call('POST', `/dynamic-pricing/apply/${listingId}`, { token, body: compact({ date }) });
  },

  /** Apply the nearest stored recommendation (generates a 7-day set first when none exist). */
  applySuggestedPricesBulk(token: string, listingId: string) {
    return call('POST', `/dynamic-pricing/apply-bulk/${listingId}`, { token, body: {} });
  },

  getSuggestedInitialPrice(token: string, listingId: string) {
    return call('GET', `/dynamic-pricing/suggested-price/${listingId}`, { token });
  },

  /** Category comes from the LISTING_CATEGORIES enum; encoded because some names contain spaces. */
  getMarketInsights(token: string, category: string) {
    return call('GET', `/dynamic-pricing/market-insights/${encodeURIComponent(category)}`, { token });
  },
};
