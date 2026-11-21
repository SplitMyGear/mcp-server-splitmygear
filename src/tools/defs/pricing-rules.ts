/**
 * Vendor pricing tools: rate rules (day, hour and departure rates, seasons) and dynamic pricing. Visible to
 * the vendor family only. Every pricing MUTATION additionally requires the
 * `change_pricing` vendor-seat capability on the backend (SPLIT-1369): owner
 * and manager seats have it, `vendor_staff` seats get a 403. Reads stay open
 * to the whole vendor family.
 */
import { z } from 'zod';
import { defineTool, fail, fromResult } from '../registry';
import { pricingRulesApi } from '../pricing-rules';
import { dateError, dateRangeError } from '../_shared';
import { uuid, isoDate, READ, WRITE, WRITE_IDEMPOTENT, DESTRUCTIVE, LISTING_CATEGORIES, token } from './common';

const STAFF_NOTE = 'Vendor owner and manager seats can change pricing; vendor_staff seats cannot (Splitt returns 403).';
/**
 * SPLIT-1947 (backend SPLIT-1945/1948): rate rules are no longer stay-only.
 * Which rate a rule may carry depends on the listing (RateRuleService
 * .assertRuleFitsListing); Splitt refuses a field the listing cannot use.
 */
const RULES_NOTE =
  'Rate rules work on every listing type: a weekday rate is a long range with a weekdayMask (e.g. every Saturday), a date override is a one-day range [D, D+1). ' +
  'Which rate a rule may carry depends on the listing: nightlyRate is the price per day on daily and both listings (per night on a stay); hourlyRate is the price per hour on hourly and both listings ' +
  'that do not run on fixed departures; slotRate is the price per departure on a fixed-departure listing; ratePct (a percentage of the base rate) works on any listing. ' +
  'minNights and apply_starter_seasons are for stays (bookingType nightly) only. Splitt refuses a rate the listing cannot use. ' +
  'A rule never changes a booking already made; quotes (get_booking_quote) and search (fromPrice) pick it up at once. ' +
  'Automatic demand-based pricing is separate: set_dynamic_pricing_config (applyWeekendPremium, applySeasonalPricing).';
const STAY_ONLY_NOTE = 'Starter seasons are for stays (bookingType nightly) only; Splitt refuses them on gear listings.';

/** Rate rules may legitimately span several years (e.g. a multi-year "always" rule). */
const MAX_RULE_SPAN_DAYS = 366 * 5;
/** Mirrors the backend's STARTER_SEASON_YEARS_AHEAD. */
const STARTER_SEASON_YEARS_AHEAD = 3;

const rateRuleFields = {
  weekdayMask: z
    .array(z.number().int().min(0).max(6))
    .max(7)
    .nullable()
    .optional()
    .describe('UTC weekdays the rule narrows to: 0=Sun, 1=Mon, ... 6=Sat. Omit for every day in the range; null (update only) clears the mask.'),
  nightlyRate: z
    .number()
    .min(0)
    .max(1_000_000)
    .multipleOf(0.01)
    .nullable()
    .optional()
    .describe('Absolute rate in USD (up to 2 decimals): per day on a daily or both listing, per night on a stay. Not on an hourly listing. Mutually exclusive with ratePct; null (update only) clears it.'),
  hourlyRate: z
    .number()
    .min(0.01)
    .max(100_000)
    .multipleOf(0.01)
    .nullable()
    .optional()
    .describe('Absolute rate per hour in USD on the days the rule covers, for hourly or both listings without fixed departures. May be set together with nightlyRate; mutually exclusive with ratePct; null (update only) clears it.'),
  slotRate: z
    .number()
    .min(0.01)
    .max(100_000)
    .multipleOf(0.01)
    .nullable()
    .optional()
    .describe('Absolute price per departure in USD on the days the rule covers, for fixed-departure listings only (e.g. 425 for a 90-minute tour on Saturdays). Mutually exclusive with ratePct; null (update only) clears it.'),
  ratePct: z
    .number()
    .int()
    .min(-90)
    .max(500)
    .nullable()
    .optional()
    .describe('Whole-number percentage adjustment of the listing base rate (per day, hour or departure, whichever is priced), -90 to 500 (e.g. 25 = +25%, -15 = 15% off). Mutually exclusive with nightlyRate, hourlyRate and slotRate; null (update only) clears it.'),
  minNights: z
    .number()
    .int()
    .min(1)
    .max(90)
    .nullable()
    .optional()
    .describe('Stays only: minimum nights required when a date in the range is the check-in night (1-90). A rule may carry only this and no rate.'),
  priority: z.number().int().min(0).max(1000).optional().describe('Override tier 0-1000 (default 0); a higher priority wins when rules overlap.'),
};

type RateFields = { nightlyRate?: number | null; hourlyRate?: number | null; slotRate?: number | null; ratePct?: number | null };

/** Mirrors the backend's RateXorConstraint: the absolute rates combine freely, a percentage excludes all of them. */
function rateXorError(input: RateFields): string | null {
  const isSet = (v: number | null | undefined): boolean => v !== null && v !== undefined;
  const absolute = (['nightlyRate', 'hourlyRate', 'slotRate'] as const).filter((k) => isSet(input[k]));
  if (absolute.length && isSet(input.ratePct)) {
    return `${absolute.join(', ')} and ratePct are mutually exclusive: set absolute rates OR a percentage adjustment, not both.`;
  }
  return null;
}

// ── Seasonal rate rules ──────────────────────────────────────────────────────

export const listRateRules = defineTool({
  name: 'list_rate_rules',
  title: 'List rate rules',
  description:
    'Rate rules (day rates, weekday rates, date overrides, seasons) on one of the vendor\'s listings: each rule has an id (for update_rate_rule / delete_rate_rule), name, startDate (inclusive), endDate (EXCLUSIVE: the first day it no longer applies), ' +
    'optional weekdayMask, nightlyRate / hourlyRate / slotRate OR ratePct, minNights, priority and source (vendor = hand-authored, starter = from apply_starter_seasons). ' +
    'Money fields come back as decimal strings. Use it before changing a listing\'s pricing. ' + RULES_NOTE,
  access: 'vendor',
  scope: 'listings',
  inputSchema: { listingId: uuid('listing') },
  annotations: READ,
  handler: async ({ listingId }, ctx) => fromResult(await pricingRulesApi.listRateRules(token(ctx), listingId)),
});

export const createRateRule = defineTool({
  name: 'create_rate_rule',
  title: 'Create a rate rule',
  description:
    'Add a rate rule to one of the vendor\'s listings: a date range (endDate is EXCLUSIVE, so a single day is [D, D+1)) with absolute rates (nightlyRate, hourlyRate, slotRate) or a ratePct adjustment of the base rate (never both), ' +
    'optionally narrowed to certain weekdays and, on a stay, carrying a minNights requirement. Example: Saturdays at $60/day all next year is startDate 2027-01-01, endDate 2028-01-01, weekdayMask [6], nightlyRate 60. ' +
    'When rules overlap, the higher priority wins, then the more specific rule. Returns the created rule with its id. A listing may hold at most 400 rules. ' +
    RULES_NOTE + ' ' + STAFF_NOTE,
  access: 'vendor',
  scope: 'listings',
  inputSchema: {
    listingId: uuid('listing'),
    name: z.string().min(1).max(80).describe('Vendor-facing label, e.g. "Summer peak" or "Holiday weekends".'),
    startDate: isoDate('Inclusive first day (night, on a stay) the rule applies to'),
    endDate: isoDate('EXCLUSIVE end: the first day the rule no longer applies to'),
    ...rateRuleFields,
  },
  annotations: WRITE,
  handler: async ({ listingId, ...input }, ctx) => {
    const rangeErr = dateRangeError(input.startDate, input.endDate, MAX_RULE_SPAN_DAYS);
    if (rangeErr) return fail(rangeErr);
    const xorErr = rateXorError(input);
    if (xorErr) return fail(xorErr);
    return fromResult(await pricingRulesApi.createRateRule(token(ctx), listingId, input));
  },
});

export const updateRateRule = defineTool({
  name: 'update_rate_rule',
  title: 'Update a rate rule',
  description:
    'Change fields of an existing rate rule (by its id from list_rate_rules). Only the fields you pass change. ' +
    'Setting any absolute rate (nightlyRate, hourlyRate, slotRate) clears a stored ratePct, and setting ratePct clears all three; pass null to clear weekdayMask, nightlyRate, hourlyRate, slotRate, ratePct or minNights. ' +
    'If you change only one of startDate/endDate, Splitt re-checks the merged range (endDate must stay after startDate), and it re-checks that the rule\'s rates still fit the listing. Returns the updated rule. ' + STAFF_NOTE,
  access: 'vendor',
  scope: 'listings',
  inputSchema: {
    ruleId: uuid('rate rule'),
    name: z.string().min(1).max(80).optional().describe('New vendor-facing label.'),
    startDate: isoDate('New inclusive first day').optional(),
    endDate: isoDate('New EXCLUSIVE end (first day the rule no longer applies to)').optional(),
    ...rateRuleFields,
  },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ ruleId, ...input }, ctx) => {
    if (Object.values(input).every((v) => v === undefined)) return fail('Pass at least one field to update.');
    if (input.startDate !== undefined && input.endDate !== undefined) {
      const rangeErr = dateRangeError(input.startDate, input.endDate, MAX_RULE_SPAN_DAYS);
      if (rangeErr) return fail(rangeErr);
    } else {
      const single = input.startDate !== undefined ? dateError('startDate', input.startDate) : input.endDate !== undefined ? dateError('endDate', input.endDate) : null;
      if (single) return fail(single);
    }
    const xorErr = rateXorError(input);
    if (xorErr) return fail(xorErr);
    return fromResult(await pricingRulesApi.updateRateRule(token(ctx), ruleId, input));
  },
});

export const deleteRateRule = defineTool({
  name: 'delete_rate_rule',
  title: 'Delete a rate rule',
  description:
    'Permanently delete one rate rule (by its id from list_rate_rules) from the vendor\'s listing. Existing bookings keep their agreed price; only future quotes change. ' +
    'Confirm with the user first. ' + STAFF_NOTE,
  access: 'vendor',
  scope: 'listings',
  inputSchema: { ruleId: uuid('rate rule') },
  annotations: DESTRUCTIVE,
  handler: async ({ ruleId }, ctx) => fromResult(await pricingRulesApi.deleteRateRule(token(ctx), ruleId), () => ({ deleted: true, ruleId })),
});

export const applyStarterSeasons = defineTool({
  name: 'apply_starter_seasons',
  title: 'Apply starter seasons',
  description:
    'One-click starter pack: creates about a dozen percentage-based seasonal rules (peak, shoulder and holiday periods) for one calendar year on a nightly listing, tagged source=starter so they stay distinguishable from the vendor\'s own rules. ' +
    'year must be the current year or up to 3 years ahead. With replaceExisting=true the listing\'s existing STARTER rules for that year are deleted and regenerated first (hand-authored rules are never touched); without it, re-applying adds duplicates. ' +
    'Confirm with the user before running it. Returns the created rules. ' + STAY_ONLY_NOTE + ' For gear, add day rates with create_rate_rule. ' + STAFF_NOTE,
  access: 'vendor',
  scope: 'listings',
  inputSchema: {
    listingId: uuid('listing'),
    year: z.number().int().min(2000).max(2200).describe('Calendar year to generate the pack for (current year up to 3 years ahead).'),
    replaceExisting: z.boolean().optional().describe('Delete this listing\'s existing starter rules for that year first (default false).'),
  },
  annotations: WRITE,
  handler: async ({ listingId, year, replaceExisting }, ctx) => {
    const currentYear = new Date().getUTCFullYear();
    if (year < currentYear || year > currentYear + STARTER_SEASON_YEARS_AHEAD) {
      return fail(`year must be between ${currentYear} and ${currentYear + STARTER_SEASON_YEARS_AHEAD}.`);
    }
    return fromResult(await pricingRulesApi.applyStarterSeasons(token(ctx), listingId, { year, replaceExisting }));
  },
});

// ── Dynamic pricing ──────────────────────────────────────────────────────────

export const getDynamicPricingConfig = defineTool({
  name: 'get_dynamic_pricing_config',
  title: 'Dynamic pricing config',
  description:
    'The dynamic pricing settings of one of the vendor\'s listings: enabled, autoUpdateEnabled, minPrice/maxPrice guard rails, customBasePrice, adjustmentSensitivity, autoUpdateFrequency, maxDailyAdjustment and the weekend/seasonal/length/weather toggles. ' +
    'A listing that never enabled it reports enabled=false. Use set_dynamic_pricing_config to change it.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: { listingId: uuid('listing') },
  annotations: READ,
  handler: async ({ listingId }, ctx) => fromResult(await pricingRulesApi.getDynamicPricingConfig(token(ctx), listingId)),
});

export const setDynamicPricingConfig = defineTool({
  name: 'set_dynamic_pricing_config',
  title: 'Configure dynamic pricing',
  description:
    'Turn dynamic pricing on/off for a listing and tune it. Only the fields you pass change. minPrice/maxPrice cap what suggestions and auto-updates may set; maxDailyAdjustment is a fraction (0.1 = at most 10% per day). ' +
    'autoUpdateEnabled lets Splitt apply suggestions on the autoUpdateFrequency schedule; leave it off to only preview suggestions and apply them yourself with apply_dynamic_pricing. Returns the saved config. ' + STAFF_NOTE,
  access: 'vendor',
  scope: 'listings',
  inputSchema: {
    listingId: uuid('listing'),
    enabled: z.boolean().optional().describe('Master switch for dynamic pricing on this listing.'),
    autoUpdateEnabled: z.boolean().optional().describe('Let Splitt apply suggested prices automatically (requires enabled=true).'),
    minPrice: z.number().min(0).max(1_000_000).nullable().optional().describe('Floor for suggested/auto-applied prices (USD per day); null removes the floor.'),
    maxPrice: z.number().min(0).max(1_000_000).nullable().optional().describe('Ceiling for suggested/auto-applied prices (USD per day); null removes the ceiling.'),
    customBasePrice: z.number().min(0).max(1_000_000).optional().describe('Base price the algorithm adjusts from, instead of the listing pricePerDay.'),
    adjustmentSensitivity: z.enum(['low', 'medium', 'high']).optional().describe('How strongly demand and competition move the price.'),
    autoUpdateFrequency: z.enum(['daily', 'weekly', 'manual']).optional(),
    maxDailyAdjustment: z.number().min(0).max(0.5).optional().describe('Max fractional price change per day, 0 to 0.5 (0.5 = 50%).'),
    applyWeekendPremium: z.boolean().optional(),
    applySeasonalPricing: z.boolean().optional(),
    applyLengthDiscounts: z.boolean().optional().describe('Discount longer rentals.'),
    applyWeatherAdjustments: z.boolean().optional(),
  },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ listingId, ...input }, ctx) => {
    if (Object.values(input).every((v) => v === undefined)) return fail('Pass at least one setting to change.');
    if (typeof input.minPrice === 'number' && typeof input.maxPrice === 'number' && input.minPrice > input.maxPrice) return fail('minPrice must not exceed maxPrice.');
    return fromResult(await pricingRulesApi.setDynamicPricingConfig(token(ctx), listingId, input));
  },
});

export const previewDynamicPrice = defineTool({
  name: 'preview_dynamic_price',
  title: 'Preview dynamic price',
  description:
    'What Splitt\'s dynamic pricing would charge for one of the vendor\'s listings, WITHOUT changing anything. Pass a single date (default today) plus an optional rental length in days for one ' +
    'suggestion: suggestedPrice, min/max, confidence, the base price and the factors (demand, weekend, season, length, ...) with their multipliers. Pass date and endDate together instead to price ' +
    'a whole stay: endDate is the checkout/return day and is not itself priced (2027-03-03 to 2027-03-10 is 7 days), both dates are required together (up to 366 days apart), and the result is ' +
    'days (one entry per priced day, each with date, price and factors), nights, totalPrice (the exact sum of days), averagePrice, and factorTotals (the whole-stay dollar total for each reason). ' +
    'Returns zeros when pricing cannot be computed. Use apply_dynamic_pricing to actually adopt a suggestion.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: {
    listingId: uuid('listing'),
    date: isoDate('Date to price (or the range start when endDate is given); default today').optional(),
    endDate: isoDate('Range end; when given, the price is computed over [date, endDate]').optional(),
    days: z.number().int().min(1).max(365).optional().describe('Rental length in days for a single-date preview (default 1). Not used with endDate.'),
  },
  annotations: READ,
  handler: async ({ listingId, date, endDate, days }, ctx) => {
    if (endDate !== undefined) {
      if (date === undefined) return fail('Pass date (the range start) together with endDate.');
      if (days !== undefined) return fail('days applies to single-date previews only; drop it or drop endDate.');
      const err = dateRangeError(date, endDate, 366);
      if (err) return fail(err);
      return fromResult(await pricingRulesApi.calculatePriceRange(token(ctx), listingId, date, endDate));
    }
    if (date !== undefined) {
      const err = dateError('date', date);
      if (err) return fail(err);
    }
    return fromResult(await pricingRulesApi.calculatePrice(token(ctx), listingId, { date, days }));
  },
});

export const getDynamicPricingRecommendations = defineTool({
  name: 'get_dynamic_pricing_recommendations',
  title: 'Pricing recommendations',
  description:
    'Stored per-day price recommendations for one of the vendor\'s listings (date, current vs recommended price, reasons, confidence, whether already applied), optionally limited to a date range. ' +
    'Returns an empty list when none have been generated yet: call generate_dynamic_pricing_recommendations first.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: {
    listingId: uuid('listing'),
    startDate: isoDate('First day to include').optional(),
    endDate: isoDate('Last day to include').optional(),
  },
  annotations: READ,
  handler: async ({ listingId, startDate, endDate }, ctx) => {
    if (startDate !== undefined && endDate !== undefined) {
      const err = dateRangeError(startDate, endDate, 366);
      if (err) return fail(err);
    } else {
      const single = startDate !== undefined ? dateError('startDate', startDate) : endDate !== undefined ? dateError('endDate', endDate) : null;
      if (single) return fail(single);
    }
    return fromResult(await pricingRulesApi.getRecommendations(token(ctx), listingId, startDate, endDate));
  },
});

export const generateDynamicPricingRecommendations = defineTool({
  name: 'generate_dynamic_pricing_recommendations',
  title: 'Generate recommendations',
  description:
    'Have Splitt compute and store fresh per-day price recommendations for one of the vendor\'s listings for the next N days (1-90, default 30), replacing stale ones. Nothing is applied to the live price. ' +
    'Returns the generated recommendations; review them, then use apply_dynamic_pricing if the vendor agrees. ' + STAFF_NOTE,
  access: 'vendor',
  scope: 'listings',
  inputSchema: {
    listingId: uuid('listing'),
    days: z.number().int().min(1).max(90).optional().describe('How many days ahead to recommend for (default 30).'),
  },
  annotations: WRITE,
  handler: async ({ listingId, days }, ctx) => fromResult(await pricingRulesApi.generateRecommendations(token(ctx), listingId, days)),
});

export const applyDynamicPricing = defineTool({
  name: 'apply_dynamic_pricing',
  title: 'Apply dynamic price',
  description:
    'OVERWRITE the listing\'s live base price (pricePerDay) with a dynamic pricing suggestion. Default: apply the suggestion for one date (today unless date is given); requires enabled=true in the config. ' +
    'bulk=true instead applies the nearest stored recommendation (generating a 7-day set first when none exist) and marks it applied; requires enabled and autoUpdateEnabled. ' +
    'The previous price is not kept, so preview with preview_dynamic_price and confirm with the user first. Returns the updated listing (and the applied count for bulk). ' + STAFF_NOTE,
  access: 'vendor',
  scope: 'listings',
  inputSchema: {
    listingId: uuid('listing'),
    bulk: z.boolean().optional().describe('Apply the nearest stored recommendation instead of a single-date calculation (default false).'),
    date: isoDate('Date whose suggested price to adopt (single mode; default today)').optional(),
  },
  annotations: DESTRUCTIVE,
  handler: async ({ listingId, bulk, date }, ctx) => {
    if (bulk) {
      if (date !== undefined) return fail('date applies to single-date apply only; drop it or set bulk=false.');
      return fromResult(await pricingRulesApi.applySuggestedPricesBulk(token(ctx), listingId));
    }
    if (date !== undefined) {
      const err = dateError('date', date);
      if (err) return fail(err);
    }
    return fromResult(await pricingRulesApi.applySuggestedPrice(token(ctx), listingId, date));
  },
});

export const getSuggestedInitialPrice = defineTool({
  name: 'get_suggested_initial_price',
  title: 'Suggested starting price',
  description:
    'A market-based starting price for one of the vendor\'s own listings: suggestedPrice, minPrice, maxPrice, marketRate and marketRateBasis. marketRateBasis is category_market (with marketRate ' +
    'set from it) when Splitt has market data for the category; when it does not, marketRateBasis is none, marketRate is null, and suggestedPrice, minPrice and maxPrice instead come from the ' +
    'listing\'s own price, not the market. Good when a listing is new or its price has never been reviewed; the public suggest_listing_price tool covers categories without a listing. Read-only.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: { listingId: uuid('listing') },
  annotations: READ,
  handler: async ({ listingId }, ctx) => fromResult(await pricingRulesApi.getSuggestedInitialPrice(token(ctx), listingId)),
});

export const getMarketInsights = defineTool({
  name: 'get_market_insights',
  title: 'Market insights',
  description:
    'Splitt\'s market benchmarks for a gear category: averageDailyRate, typical weeklyDiscount and monthlyDiscount (fractions), peakSeason and peakMultiplier. ' +
    'Use it to sanity-check a vendor\'s base price, discounts and seasonal rules. Categories without market data (e.g. Other) return not found.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: { category: z.enum(LISTING_CATEGORIES).describe('Gear category.') },
  annotations: READ,
  handler: async ({ category }, ctx) => fromResult(await pricingRulesApi.getMarketInsights(token(ctx), category)),
});

export const pricingRulesTools = [
  listRateRules,
  createRateRule,
  updateRateRule,
  deleteRateRule,
  applyStarterSeasons,
  getDynamicPricingConfig,
  setDynamicPricingConfig,
  previewDynamicPrice,
  getDynamicPricingRecommendations,
  generateDynamicPricingRecommendations,
  applyDynamicPricing,
  getSuggestedInitialPrice,
  getMarketInsights,
];
