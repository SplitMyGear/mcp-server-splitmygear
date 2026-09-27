/**
 * Discovery extras: saved searches (search alerts) and saved trips for the
 * signed-in user (scope `favorites`), plus the public trip planner,
 * destinations and category catalogue (scope `read`).
 */
import { z } from 'zod';
import { defineTool, fail, fromResult, ok } from '../registry';
import { discoveryExtrasTools as extras, POI_RECIPES, SEARCH_ALERT_FREQUENCIES } from '../discovery-extras';
import { dateError } from '../_shared';
import { uuid, isoDate, READ, WRITE, WRITE_IDEMPOTENT, DESTRUCTIVE, UNTRUSTED_NOTE, token, LISTING_CATEGORIES } from './common';

/**
 * The backend's canonical listing categories (listing/listing-categories.ts),
 * which the trip planner and alert matcher validate against. Includes the
 * stays categories (Cabins, Campsites, RV Sites, Glamping) and ATVs that the
 * older shared LISTING_CATEGORIES list predates.
 */
/** The canonical listing categories (shared with search_listings / create_listing). */
export const CATEGORY_NAMES = LISTING_CATEGORIES;

export const EXPERIENCE_LEVELS = ['beginner', 'intermediate', 'advanced'] as const;
export const TRIP_PLAN_SOURCES = ['board', 'fallback'] as const;

/** The trip planner spans at most 30 days (backend MAX_TRIP_SPAN_DAYS). */
const MAX_TRIP_DAYS = 30;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Strict calendar day, YYYY-MM-DD, that really exists (rejects 2026-02-31). */
function isRealDay(value: string): boolean {
  if (!DAY_RE.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

function dayError(label: string, value: string): string | null {
  return isRealDay(value) ? null : `Invalid ${label}: "${value}". Use a real calendar day in YYYY-MM-DD form, e.g. 2026-07-04.`;
}

/**
 * Trip date pair: both or neither, end not before start, inclusive span of at
 * most 30 days. `strictDay` enforces YYYY-MM-DD (the /trips query DTOs);
 * otherwise any parseable ISO date/timestamp is accepted (IsDateString DTOs).
 */
function tripDatesError(start: string | undefined, end: string | undefined, labels: [string, string], strictDay: boolean): string | null {
  if (start === undefined && end === undefined) return null;
  if (start === undefined || end === undefined) return `Pass both ${labels[0]} and ${labels[1]}, or neither.`;
  const check = strictDay ? dayError : dateError;
  const s = check(labels[0], start);
  if (s) return s;
  const e = check(labels[1], end);
  if (e) return e;
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (endMs < startMs) return `${labels[1]} must not be before ${labels[0]}.`;
  if (Math.round((endMs - startMs) / 86_400_000) + 1 > MAX_TRIP_DAYS) return `A trip may span at most ${MAX_TRIP_DAYS} days.`;
  return null;
}

function priceRangeError(minPrice?: number, maxPrice?: number): string | null {
  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) return 'minPrice must not exceed maxPrice.';
  return null;
}

function geoError(latitude?: number, longitude?: number, radiusKm?: number): string | null {
  if ((latitude === undefined) !== (longitude === undefined)) return 'Pass both latitude and longitude, or neither.';
  if (radiusKm !== undefined && latitude === undefined) return 'radiusKm needs latitude and longitude.';
  return null;
}

/** Unwrap the backend's `{ success, <key>: ... }` envelope when present. */
const pick = (key: string) => (data: unknown) =>
  data && typeof data === 'object' && key in (data as Record<string, unknown>) ? (data as Record<string, unknown>)[key] : data;

const hasCriteria = (a: { searchQuery?: string; category?: string; location?: string; minPrice?: number; maxPrice?: number; latitude?: number }) =>
  Boolean(a.searchQuery?.trim() || a.category || a.location?.trim() || a.minPrice !== undefined || a.maxPrice !== undefined || a.latitude !== undefined);

/** `CreateSearchAlertDto` criteria fields (all optional). */
const alertCriteria = {
  searchQuery: z.string().max(200).optional().describe('Free-text keywords to match against new listings, e.g. "tandem kayak".'),
  category: z.string().min(1).max(60).optional().describe('Listing category to watch, exactly as returned by list_categories (canonical names such as "Camping", or a live category from the catalogue).'),
  minPrice: z.number().min(0).max(100000).optional().describe('Minimum price per day (USD).'),
  maxPrice: z.number().min(0).max(100000).optional().describe('Maximum price per day (USD).'),
  location: z.string().max(200).optional().describe('City or area text, e.g. "Austin, TX".'),
  latitude: z.number().min(-90).max(90).optional().describe('Optional geo filter centre (pair with longitude).'),
  longitude: z.number().min(-180).max(180).optional(),
  radiusKm: z.number().min(1).max(500).optional().describe('Radius around latitude/longitude in km.'),
  frequency: z.enum(SEARCH_ALERT_FREQUENCIES).optional().describe('How often to notify: instant, daily (default) or weekly.'),
};

/** Shared trip fields for save_trip and email_trip_plan (CreateSavedTripDto / EmailTripPlanDto). */
const tripFields = {
  destination: z.string().min(1).max(120).describe('Place name as shown by plan_trip or suggest_locations, e.g. "Lake Minnetonka, MN".'),
  numPeople: z.number().int().min(1).max(20).describe('Group size.'),
  startDate: isoDate('Trip start').optional(),
  endDate: isoDate('Trip end').optional(),
  duration: z.number().int().min(1).max(MAX_TRIP_DAYS).optional().describe('Trip length in days when no dates are fixed.'),
};

// ── Search alerts (saved searches) ───────────────────────────────────────────

export const listSearchAlerts = defineTool({
  name: 'list_search_alerts',
  title: 'My saved searches',
  description:
    'Saved searches (search alerts) the signed-in user set up: id, name, criteria (keywords, category, price range, location), frequency, isActive, ' +
    'how many times it has notified and when. Splitt evaluates active alerts against newly listed gear and notifies the user. ' +
    'Pass alertId to get one alert with its geo filter (latitude/longitude/radiusKm). Ids feed update_search_alert, toggle_search_alert and delete_search_alert.',
  access: 'user',
  scope: 'favorites',
  inputSchema: { alertId: uuid('search alert').optional().describe('Fetch one alert (UUID). Omit to list all.') },
  annotations: READ,
  handler: async ({ alertId }, ctx) =>
    alertId ? fromResult(await extras.getSearchAlert(token(ctx), alertId), pick('alert')) : fromResult(await extras.listSearchAlerts(token(ctx)), pick('alerts')),
});

export const createSearchAlert = defineTool({
  name: 'create_search_alert',
  title: 'Save a search',
  description:
    'Save a search as an alert for the signed-in user: Splitt notifies them (instant, daily or weekly) when newly listed gear matches the criteria. ' +
    'Pass at least one criterion (keywords, category, location, price range or a latitude/longitude radius). Returns the created alert. ' +
    'Use it when the user says "let me know when a ... becomes available" or wants to save their current search.',
  access: 'user',
  scope: 'favorites',
  inputSchema: {
    name: z.string().min(1).max(120).describe('Short label the user will recognise, e.g. "Kayaks near Austin under $50".'),
    ...alertCriteria,
    isActive: z.boolean().optional().describe('Start paused by passing false (default active).'),
  },
  annotations: WRITE,
  handler: async (args, ctx) => {
    if (!hasCriteria(args)) return fail('Pass at least one criterion: searchQuery, category, location, minPrice/maxPrice or latitude+longitude.');
    const err = priceRangeError(args.minPrice, args.maxPrice) ?? geoError(args.latitude, args.longitude, args.radiusKm);
    if (err) return fail(err);
    return fromResult(await extras.createSearchAlert(token(ctx), { ...args, name: args.name.trim(), searchQuery: args.searchQuery?.trim() || undefined }), pick('alert'));
  },
});

export const updateSearchAlert = defineTool({
  name: 'update_search_alert',
  title: 'Edit a saved search',
  description:
    'Change a saved search: rename it, or replace its keywords, category, price range, location, geo radius, frequency or isActive. ' +
    'Only the fields you pass change; the others keep their current values. Returns the updated alert summary.',
  access: 'user',
  scope: 'favorites',
  inputSchema: {
    alertId: uuid('search alert'),
    name: z.string().min(1).max(120).optional(),
    ...alertCriteria,
    isActive: z.boolean().optional(),
  },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ alertId, ...fields }, ctx) => {
    if (Object.values(fields).every((v) => v === undefined)) return fail('Pass at least one field to update.');
    const err = priceRangeError(fields.minPrice, fields.maxPrice) ?? geoError(fields.latitude, fields.longitude, fields.radiusKm);
    if (err) return fail(err);
    return fromResult(await extras.updateSearchAlert(token(ctx), alertId, { ...fields, name: fields.name?.trim() }), pick('alert'));
  },
});

export const toggleSearchAlert = defineTool({
  name: 'toggle_search_alert',
  title: 'Pause / resume alert',
  description:
    'Pause or resume a saved search. Pass isActive to set a definite state (true = notify, false = paused; safe to repeat), ' +
    'or omit it to flip the current state. Returns the resulting isActive. Paused alerts are kept but never notify.',
  access: 'user',
  scope: 'favorites',
  inputSchema: {
    alertId: uuid('search alert'),
    isActive: z.boolean().optional().describe('Desired state. Omit to flip whatever it is now.'),
  },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ alertId, isActive }, ctx) =>
    isActive === undefined
      ? fromResult(await extras.toggleSearchAlert(token(ctx), alertId), (d) => ({ alertId, isActive: (d as { isActive?: boolean })?.isActive }))
      : fromResult(await extras.updateSearchAlert(token(ctx), alertId, { isActive }), (d) => ({ alertId, isActive: (pick('alert')(d) as { isActive?: boolean })?.isActive ?? isActive })),
});

export const deleteSearchAlert = defineTool({
  name: 'delete_search_alert',
  title: 'Delete saved search',
  description:
    'Permanently delete one of the signed-in user\'s saved searches (search alerts). Cannot be undone; confirm with the user first. ' +
    'To stop notifications without losing the criteria, use toggle_search_alert instead.',
  access: 'user',
  scope: 'favorites',
  inputSchema: { alertId: uuid('search alert') },
  annotations: DESTRUCTIVE,
  handler: async ({ alertId }, ctx) => fromResult(await extras.deleteSearchAlert(token(ctx), alertId), () => ({ deleted: true, alertId })),
});

// ── Saved trips ──────────────────────────────────────────────────────────────

export const listSavedTrips = defineTool({
  name: 'list_saved_trips',
  title: 'My saved trips',
  description:
    'Trips the signed-in user saved from the planner: id, destination, dates or duration, group size, activities and the plan snapshot (summary, budget). ' +
    'Re-run plan_trip with the same inputs to rebuild the full board. Ids feed delete_saved_trip.',
  access: 'user',
  scope: 'favorites',
  inputSchema: {},
  annotations: READ,
  handler: async (_args, ctx) => fromResult(await extras.listSavedTrips(token(ctx)), pick('trips')),
});

export const saveTrip = defineTool({
  name: 'save_trip',
  title: 'Save a trip',
  description:
    'Save a planned trip to the signed-in user\'s account (shown at go-splitt.com/trips) so they can reopen it later. ' +
    'Pass the destination, group size and activities used with plan_trip, plus either startDate+endDate or duration in days; optionally a short summary and budget as the plan snapshot. Returns the saved trip.',
  access: 'user',
  scope: 'favorites',
  inputSchema: {
    ...tripFields,
    activities: z.array(z.string().min(1).max(40)).min(1).max(10).describe('Activities / listing categories, e.g. ["Boating", "Biking"].'),
    tripSummary: z.string().max(600).optional().describe('One or two sentences describing the plan (stored in the snapshot).'),
    totalEstimatedBudget: z.string().max(40).optional().describe('Budget text, e.g. "$450 to $600".'),
    source: z.enum(TRIP_PLAN_SOURCES).optional().describe('Which planner produced it: board (plan_trip) or fallback (generate_ai_trip_plan).'),
  },
  annotations: WRITE,
  handler: async ({ destination, numPeople, activities, startDate, endDate, duration, tripSummary, totalEstimatedBudget, source }, ctx) => {
    const err = tripDatesError(startDate, endDate, ['startDate', 'endDate'], false);
    if (err) return fail(err);
    if (startDate === undefined && duration === undefined) return fail('Pass startDate and endDate, or duration (days).');
    const snapshot = { tripSummary: tripSummary?.trim() || undefined, totalEstimatedBudget: totalEstimatedBudget?.trim() || undefined, source };
    const planSnapshot = Object.values(snapshot).some((v) => v !== undefined) ? snapshot : undefined;
    return fromResult(
      await extras.saveTrip(token(ctx), { destination: destination.trim(), numPeople, activities, startDate, endDate, duration, planSnapshot }),
      pick('trip'),
    );
  },
});

export const deleteSavedTrip = defineTool({
  name: 'delete_saved_trip',
  title: 'Delete saved trip',
  description: 'Remove a trip from the signed-in user\'s saved trips. Cannot be undone; confirm with the user first. Only the owner can delete it.',
  access: 'user',
  scope: 'favorites',
  inputSchema: { tripId: uuid('saved trip') },
  annotations: DESTRUCTIVE,
  handler: async ({ tripId }, ctx) => fromResult(await extras.deleteSavedTrip(token(ctx), tripId), () => ({ deleted: true, tripId })),
});

export const emailTripPlan = defineTool({
  name: 'email_trip_plan',
  title: 'Email me this trip',
  description:
    'Email a trip plan to the signed-in user\'s own Splitt email address (no other recipient is possible). Pass the trip basics plus, optionally, ' +
    'the summary, budget, gear checklist rows and POI highlights from plan_trip / generate_ai_trip_plan so the email mirrors what they saw. ' +
    'Each call sends one email and Splitt allows about 5 per 10 minutes, so confirm with the user before sending. Returns { sent: true }.',
  access: 'user',
  scope: 'favorites',
  inputSchema: {
    ...tripFields,
    activities: z.array(z.string().min(1).max(40)).max(10).optional().describe('Activities / listing categories.'),
    tripSummary: z.string().max(600).optional(),
    totalEstimatedBudget: z.string().max(40).optional().describe('Budget text, e.g. "$450 to $600".'),
    gearCategories: z
      .array(z.object({ category: z.string().min(1).max(60), priority: z.string().max(20).optional(), itemCount: z.number().int().min(0).max(99).optional() }))
      .max(12)
      .optional()
      .describe('Gear checklist rows: category, optional priority (e.g. "High") and item count.'),
    poiHighlights: z
      .array(z.object({ name: z.string().min(1).max(80), group: z.string().max(40).optional() }))
      .max(12)
      .optional()
      .describe('"Along the way" points of interest: name and optional group title (e.g. "Food & drink").'),
    source: z.enum(TRIP_PLAN_SOURCES).optional().describe('board (plan_trip) or fallback (generate_ai_trip_plan).'),
  },
  annotations: WRITE,
  handler: async (args, ctx) => {
    const err = tripDatesError(args.startDate, args.endDate, ['startDate', 'endDate'], false);
    if (err) return fail(err);
    return fromResult(await extras.emailTripPlan(token(ctx), { ...args, destination: args.destination.trim() }), () => ({
      sent: true,
      destination: args.destination.trim(),
      note: 'Sent to the email address on the user\'s Splitt account.',
    }));
  },
});

// ── Trip planning (public) ───────────────────────────────────────────────────

export const planTrip = defineTool({
  name: 'plan_trip',
  title: 'Plan a trip',
  description:
    'Build a Splitt trip board for a destination: the geocoded place, a daily weather outlook, public holidays, nearby rentable gear and bookable experiences ' +
    'for the chosen activities, points-of-interest groups (recipes) and a day-by-day itinerary skeleton. Give a destination (city, park, lake), 1 to 6 activities ' +
    '(listing categories), and either start+end dates (max 30 days) or a day count. Fill each poiGroups[].recipe with get_trip_pois using destination.lat/lng; ' +
    'get_listing_details / get_experience_details for anything the user wants to book. If the place cannot be geocoded, try suggest_locations for an exact name. ' +
    UNTRUSTED_NOTE,
  access: 'public',
  scope: 'read',
  inputSchema: {
    destination: z.string().min(2).max(120).describe('Where the trip is, e.g. "Yosemite National Park, CA" or a label from suggest_locations.'),
    activities: z.array(z.enum(CATEGORY_NAMES)).min(1).max(6).describe('1 to 6 listing categories the trip is about, e.g. ["Kayaking", "Camping"].'),
    start: z.string().max(10).optional().describe('Trip start day, YYYY-MM-DD.'),
    end: z.string().max(10).optional().describe('Trip end day, YYYY-MM-DD (requires start; at most 30 days after it). Alternatively pass start with days.'),
    days: z.number().int().min(1).max(MAX_TRIP_DAYS).optional().describe('Trip length in days when no dates are fixed (1 to 30).'),
    people: z.number().int().min(1).max(20).optional().describe('Group size (1 to 20).'),
  },
  annotations: READ,
  handler: async ({ destination, activities, start, end, days, people }) => {
    if (start !== undefined && end === undefined) {
      // The backend accepts a start day plus a day count as well as a start/end pair.
      const err = dayError('start', start);
      if (err) return fail(err);
      if (days === undefined) return fail('With start alone, also pass days (1 to 30), or pass an end date instead.');
    } else {
      const err = tripDatesError(start, end, ['start', 'end'], true);
      if (err) return fail(err);
    }
    return fromResult(await extras.planTrip({ destination: destination.trim(), activities, start, end, days, people }), (plan) => {
      const p = plan as { available?: boolean; reason?: string } | null;
      if (p && p.available === false) {
        return { ...p, hint: 'Splitt could not place that destination on the map. Ask the user for a more specific place, or use suggest_locations to find the exact label.' };
      }
      return plan;
    });
  },
});

export const getTripPois = defineTool({
  name: 'get_trip_pois',
  title: 'Points of interest',
  description:
    'Up to 6 ranked points of interest around a map point for one recipe: trails-bike, trails-hike, food-drink, on-water (marinas, beaches), parks-views or camping. ' +
    'Use the destination.lat/lng and poiGroups[].recipe values returned by plan_trip, or any coordinates. Each POI has a name, kind, distance and OpenStreetMap / directions links. ' +
    'Radius is in km (1 to 50; each recipe has a sensible default).',
  access: 'public',
  scope: 'read',
  inputSchema: {
    lat: z.number().min(-90).max(90).describe('Latitude of the search centre.'),
    lng: z.number().min(-180).max(180).describe('Longitude of the search centre.'),
    recipe: z.enum(POI_RECIPES).describe('Which kind of places to find.'),
    radius: z.number().int().min(1).max(50).optional().describe('Search radius in whole km (default depends on the recipe).'),
  },
  annotations: READ,
  handler: async (args) => fromResult(await extras.getTripPois(args)),
});

export const getTripIdeasForListing = defineTool({
  name: 'get_trip_ideas_for_listing',
  title: 'Make a day of it',
  description:
    '"Make a day of it" ideas for a listing: nearby trails, food, water access or parks that pair with the gear, plus bookable experiences close by, ' +
    'anchored on the listing\'s location and category. Optionally pass the booking start/end days (YYYY-MM-DD) to include a weather hint. ' +
    'Use it when a renter is considering or has booked a listing and wants suggestions for the day. ' + UNTRUSTED_NOTE,
  access: 'public',
  scope: 'read',
  inputSchema: {
    listingId: uuid('listing'),
    start: z.string().max(10).optional().describe('Booking start day, YYYY-MM-DD.'),
    end: z.string().max(10).optional().describe('Booking end day, YYYY-MM-DD.'),
  },
  annotations: READ,
  handler: async ({ listingId, start, end }) => {
    for (const [label, value] of [['start', start], ['end', end]] as Array<[string, string | undefined]>) {
      if (value !== undefined) {
        const err = dayError(label, value);
        if (err) return fail(err);
      }
    }
    return fromResult(await extras.getTripIdeas(listingId, start, end));
  },
});

export const suggestLocations = defineTool({
  name: 'suggest_locations',
  title: 'Suggest locations',
  description:
    'Type-ahead place lookup for trip planning: turns a partial or ambiguous place name (2 to 80 characters, e.g. "lake minnet") into up to a handful of ' +
    'geocoded suggestions with a display label, latitude and longitude. Use a returned label as the destination for plan_trip, or the coordinates for get_trip_pois.',
  access: 'public',
  scope: 'read',
  inputSchema: { query: z.string().min(2).max(80).describe('Partial place name.') },
  annotations: READ,
  handler: async ({ query }) => {
    const q = query.trim();
    if (q.length < 2) return fail('query must be at least 2 characters after trimming.');
    return fromResult(await extras.suggestLocations(q), pick('suggestions'));
  },
});

export const generateAiTripPlan = defineTool({
  name: 'generate_ai_trip_plan',
  title: 'AI gear plan',
  description:
    'AI-written packing and gear plan for a trip: a trip summary, gear categories with priorities and suggested items to rent, pro tips and an estimated budget. ' +
    'Give the destination, trip length in days, group size, activities (free text, 1 to 10) and optionally the group\'s experience level. ' +
    'Prefer plan_trip for real nearby listings, weather and itinerary; use this for a narrative checklist or when plan_trip cannot geocode the place. ' +
    'Generation takes several seconds and may return { available: false } when Splitt\'s AI is off or busy; nothing is stored.',
  access: 'public',
  scope: 'read',
  inputSchema: {
    destination: z.string().min(1).max(120),
    duration: z.number().int().min(1).max(MAX_TRIP_DAYS).describe('Trip length in days (1 to 30).'),
    numPeople: z.number().int().min(1).max(20).describe('Group size (1 to 20).'),
    activities: z.array(z.string().min(1).max(60)).min(1).max(10).describe('Activities in plain words, e.g. ["hiking", "kayaking"].'),
    experienceLevel: z.enum(EXPERIENCE_LEVELS).optional().describe('Group\'s experience level; shapes the gear suggestions.'),
  },
  annotations: READ,
  handler: async (args) => fromResult(await extras.generateAiTripPlan({ ...args, destination: args.destination.trim() })),
});

// ── Destinations (public) ────────────────────────────────────────────────────

export const listDestinations = defineTool({
  name: 'list_destinations',
  title: 'List destinations',
  description:
    'Splitt\'s curated outdoor destinations (state parks, recreation areas, lakes): slug, name, region, coordinates, description, official site, activity types and ' +
    'how many routes are mapped there. Use it to answer "where can I go for ..." and to pick a slug for get_destination or a destination name for plan_trip.',
  access: 'public',
  scope: 'read',
  inputSchema: {},
  annotations: READ,
  handler: async () => fromResult(await extras.listDestinations(), pick('destinations')),
});

export const getDestination = defineTool({
  name: 'get_destination',
  title: 'Destination details',
  description:
    'One curated destination by slug (from list_destinations): its details plus the routes mapped there, gear listings and experiences within about 50 km, ' +
    'and the closest other destinations. Use it to build a "what to do and rent at X" answer; follow up with plan_trip for dates and weather. ' + UNTRUSTED_NOTE,
  access: 'public',
  scope: 'read',
  inputSchema: {
    slug: z.string().min(1).max(80).regex(SLUG_RE, 'Use the lowercase hyphenated slug from list_destinations, e.g. "itasca-state-park".').describe('Destination slug from list_destinations.'),
  },
  annotations: READ,
  handler: async ({ slug }) => fromResult(await extras.getDestination(slug), pick('destination')),
});

// ── Categories (public) ──────────────────────────────────────────────────────

export const listCategories = defineTool({
  name: 'list_categories',
  title: 'List categories',
  description:
    'The live gear category catalogue (id, name, slug, description, icon, sort order) that listings and search filters use. ' +
    'Pass withListingCounts to also get how many listings each category has. Use the `name` values as the category filter for search_listings and create_search_alert.',
  access: 'public',
  scope: 'read',
  inputSchema: { withListingCounts: z.boolean().optional().describe('Include listingCount per category (default false).') },
  annotations: READ,
  handler: async ({ withListingCounts }) => fromResult(await extras.listCategories(withListingCounts === true), pick('categories')),
});

export const getCategory = defineTool({
  name: 'get_category',
  title: 'Category details',
  description:
    'One gear category by id (from list_categories) with its total number of listings on Splitt. Use it to check whether a category has inventory before recommending it.',
  access: 'public',
  scope: 'read',
  inputSchema: { categoryId: uuid('category') },
  annotations: READ,
  handler: async ({ categoryId }) => {
    const [category, stats] = await Promise.all([extras.getCategory(categoryId), extras.getCategoryStats(categoryId)]);
    if (!category.ok) return fromResult(category);
    if (!stats.ok) return fromResult(stats);
    const totalListings = (pick('stats')(stats.data) as { totalListings?: number } | null)?.totalListings ?? null;
    return ok({ category: pick('category')(category.data), totalListings });
  },
});

export const discoveryExtrasTools = [
  listSearchAlerts,
  createSearchAlert,
  updateSearchAlert,
  toggleSearchAlert,
  deleteSearchAlert,
  listSavedTrips,
  saveTrip,
  deleteSavedTrip,
  emailTripPlan,
  planTrip,
  getTripPois,
  getTripIdeasForListing,
  suggestLocations,
  generateAiTripPlan,
  listDestinations,
  getDestination,
  listCategories,
  getCategory,
];
