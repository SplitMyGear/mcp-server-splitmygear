/**
 * Vendor pricing tools: seasonal rate rules and dynamic pricing. Visible to
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
const NIGHTLY_NOTE = 'Seasonal rate rules apply to nightly (stay) listings only; hourly listings are rejected.';

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
    .describe('Absolute per-night rate in USD (up to 2 decimals). Mutually exclusive with ratePct; null (update only) clears it.'),
  ratePct: z
    .number()
    .int()
    .min(-90)
    .max(500)
    .nullable()
    .optional()
    .describe('Whole-number percentage adjustment of the listing base rate, -90 to 500 (e.g. 25 = +25%, -15 = 15% off). Mutually exclusive with nightlyRate; null (update only) clears it.'),
  minNights: z
    .number()
    .int()
    .min(1)
    .max(90)
    .nullable()
    .optional()
    .describe('Minimum nights required when a date in the range is the check-in night (1-90). A rule may carry only this and no rate.'),
  priority: z.number().int().min(0).max(1000).optional().describe('Override tier 0-1000 (default 0); a higher priority wins when rules overlap.'),
};

function rateXorError(nightlyRate: number | null | undefined, ratePct: number | null | undefined): string | null {
  const isSet = (v: number | null | undefined): boolean => v !== null && v !== undefined;
  if (isSet(nightlyRate) && isSet(ratePct)) return 'nightlyRate and ratePct are mutually exclusive: set an absolute nightly rate OR a percentage adjustment, not both.';
  return null;
}

// ── Seasonal rate rules ──────────────────────────────────────────────────────

export const listRateRules = defineTool({
  name: 'list_rate_rules',
  title: 'List seasonal rate rules',
  description:
    'Seasonal rate rules on one of the vendor\'s listings: each rule has an id (for update_rate_rule / delete_rate_rule), name, startDate (inclusive), endDate (EXCLUSIVE: the first night it no longer applies), ' +
    'optional weekdayMask, nightlyRate OR ratePct, minNights, priority and source (vendor = hand-authored, starter = from apply_starter_seasons). ' +
    'Use it before changing pricing on a stay listing. ' + NIGHTLY_NOTE,
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
    'Add a seasonal rate rule to one of the vendor\'s nightly listings: a date range (endDate is EXCLUSIVE, so a single night is [D, D+1)) with either an absolute nightlyRate or a ratePct adjustment of the base rate (never both), ' +
    'optionally narrowed to certain weekdays and/or carrying a minNights requirement. Returns the created rule with its id. A listing may hold at most 400 rules. ' +
    NIGHTLY_NOTE + ' ' + STAFF_NOTE,
  access: 'vendor',
  scope: 'listings',
  inputSchema: {
    listingId: uuid('listing'),
    name: z.string().min(1).max(80).describe('Vendor-facing label, e.g. "Summer peak" or "Holiday weekends".'),
    startDate: isoDate('Inclusive first night the rule applies to'),
    endDate: isoDate('EXCLUSIVE end: the first night the rule no longer applies to'),
    ...rateRuleFields,
  },
  annotations: WRITE,
  handler: async ({ listingId, ...input }, ctx) => {
    const rangeErr = dateRangeError(input.startDate, input.endDate, MAX_RULE_SPAN_DAYS);
    if (rangeErr) return fail(rangeErr);
    const xorErr = rateXorError(input.nightlyRate, input.ratePct);
    if (xorErr) return fail(xorErr);
    return fromResult(await pricingRulesApi.createRateRule(token(ctx), listingId, input));
  },
});

export const updateRateRule = defineTool({
  name: 'update_rate_rule',
  title: 'Update a rate rule',
  description:
    'Change fields of an existing seasonal rate rule (by its id from list_rate_rules). Only the fields you pass change. ' +
    'Setting nightlyRate clears any stored ratePct and vice versa; pass null to clear weekdayMask, nightlyRate, ratePct or minNights. ' +
    'If you change only one of startDate/endDate, Splitt re-checks the merged range (endDate must stay after startDate). Returns the updated rule. ' + STAFF_NOTE,
  access: 'vendor',
  scope: 'listings',
  inputSchema: {
    ruleId: uuid('rate rule'),
    name: z.string().min(1).max(80).optional().describe('New vendor-facing label.'),
    startDate: isoDate('New inclusive first night').optional(),
    endDate: isoDate('New EXCLUSIVE end (first night the rule no longer applies to)').optional(),
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
    const xorErr = rateXorError(input.nightlyRate, input.ratePct);
    if (xorErr) return fail(xorErr);
    return fromResult(await pricingRulesApi.updateRateRule(token(ctx), ruleId, input));
  },
});

export const deleteRateRule = defineTool({
  name: 'delete_rate_rule',
  title: 'Delete a rate rule',
  description:
    'Permanently delete one seasonal rate rule (by its id from list_rate_rules) from the vendor\'s listing. Existing bookings keep their agreed price; only future quotes change. ' +
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
    'Confirm with the user before running it. Returns the created rules. ' + NIGHTLY_NOTE + ' ' + STAFF_NOTE,
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
    minPrice: z.number().min(0).max(1_000_000).optional().describe('Floor for suggested/auto-applied prices (USD per day).'),
    maxPrice: z.number().min(0).max(1_000_000).optional().describe('Ceiling for suggested/auto-applied prices (USD per day).'),
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
    if (input.minPrice !== undefined && input.maxPrice !== undefined && input.minPrice > input.maxPrice) return fail('minPrice must not exceed maxPrice.');
    return fromResult(await pricingRulesApi.setDynamicPricingConfig(token(ctx), listingId, input));
  },
});

export const previewDynamicPrice = defineTool({
  name: 'preview_dynamic_price',
  title: 'Preview dynamic price',
  description:
    'What Splitt\'s dynamic pricing would charge for one of the vendor\'s listings, WITHOUT changing anything: suggestedPrice, min/max, confidence, the base price and the factors (demand, weekend, season, length, ...) with their multipliers. ' +
    'Pass a single date (default today) plus an optional rental length in days, or pass date + endDate to get the aggregate over a date range. Returns zeros when pricing cannot be computed. ' +
    'Use apply_dynamic_pricing to actually adopt a suggestion.',
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
    'A market-based starting price for one of the vendor\'s own listings (suggestedPrice, minPrice, maxPrice, marketRate), derived from its category, value and market data. ' +
    'Good when a listing is new or its price has never been reviewed; the public suggest_listing_price tool covers categories without a listing. Read-only.',
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
