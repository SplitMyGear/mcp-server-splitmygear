/**
 * Routes: the vendor's reusable route/trail library (draw or import once,
 * attach to many listings), public shared-route pages, listing route
 * attachments, and the legacy per-listing "Routes & permits" cards.
 * Library and link writes are vendor-only; the two reads are public.
 */
import { z } from 'zod';
import { defineTool, fail, fromResult } from '../registry';
import {
  routesApi,
  geometryError,
  summarizeDraft,
  ROUTE_ACTIVITY_TYPES,
  ROUTE_SURFACES,
  ROUTE_DIFFICULTY_LEVELS,
  ROUTE_POI_KINDS,
  ROUTE_CREATE_SOURCES,
  LEGACY_ROUTE_DIFFICULTIES,
  LEGACY_ROUTE_STATUSES,
  MAX_LINKED_ROUTES_PER_LISTING,
  MAX_GPX_BYTES,
} from '../routes';
import { uuid, READ, WRITE, WRITE_IDEMPOTENT, DESTRUCTIVE, UNTRUSTED_NOTE, token } from './common';

const SITE_URL = 'https://go-splitt.com';

// ── Shared schema fragments ──────────────────────────────────────────────────

const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);
const httpsUrl = (max: number) => z.string().url().max(max).startsWith('https://', 'Must be an https:// URL.');

const geometrySchema = z
  .array(z.array(z.number()).min(2).max(3))
  .min(2)
  .max(5000)
  .describe(
    'The track as an ordered list of 2 to 5000 points, each [lng, lat] or [lng, lat, elevationM]; LONGITUDE FIRST. ' +
      'Splitt derives distance, elevation gain/loss, max grade, effort score, start/end and a default difficulty and duration from it.',
  );

const cuePointSchema = z.object({
  dM: z.number().min(0).describe('Distance from the route start, in meters.'),
  text: z.string().min(1).max(200).describe('The instruction, e.g. "Turn left onto Ridge Trail".'),
  type: z.string().max(40).optional().describe('Cue kind, e.g. left, right, straight, summit, water.'),
  lat: latitude.optional(),
  lng: longitude.optional(),
});

const poiSchema = z.object({
  name: z.string().min(1).max(120),
  lat: latitude,
  lng: longitude,
  kind: z.enum(ROUTE_POI_KINDS),
  note: z.string().max(280).optional(),
});

const permitSchema = z.object({
  name: z.string().min(1).max(160).describe('Permit or pass name, e.g. "Northwest Forest Pass".'),
  authority: z.string().max(160).optional().describe('Who issues it.'),
  url: httpsUrl(500).optional().describe('Where to buy or read about it (https only).'),
  required: z.boolean().describe('true if renters must hold it; false if recommended.'),
  cost: z.string().max(40).optional().describe('Free text, e.g. "$5/day".'),
  notes: z.string().max(280).optional(),
});

/** Optional fields shared by create_route and update_route (mirrors CreateRouteDto). */
const routeOptionalFields = {
  geometry: geometrySchema.optional(),
  surface: z.enum(ROUTE_SURFACES).optional().describe('Dominant surface.'),
  unpavedPct: z.number().int().min(0).max(100).optional().describe('Share of the route that is unpaved, 0 to 100 (feeds effort/difficulty).'),
  cuePoints: z.array(cuePointSchema).max(200).optional().describe('Turn-by-turn cues, ordered by distance.'),
  pois: z.array(poiSchema).max(50).optional().describe('Points of interest along the route (trailhead, parking, water, hazard, launch...).'),
  hazards: z.string().max(2000).optional().describe('Free-text hazard notes shown to renters.'),
  seasonality: z.string().max(120).optional().describe('When the route is usable, e.g. "May to October".'),
  permits: z.array(permitSchema).max(20).optional().describe('Permits or passes renters need.'),
  source: z.enum(ROUTE_CREATE_SOURCES).optional().describe('How the geometry was produced (default drawn).'),
  sourceRef: httpsUrl(500).optional().describe('Origin of the route (https URL), if any.'),
};

const routeName = z.string().min(1).max(140).describe('Public route name.');
const routeSummary = z.string().max(4000).describe('Public description of the route.');
const routeDifficulty = z.enum(ROUTE_DIFFICULTY_LEVELS).describe('Manual difficulty; omit to let Splitt compute it from the track and activity.');
const routeDuration = z.number().int().min(1).max(14400).describe('Manual estimated duration in minutes; omit to let Splitt compute it.');
const activityType = z.enum(ROUTE_ACTIVITY_TYPES).describe('What the route is for; drives the computed difficulty and duration.');

const shareSlug = z
  .string()
  .regex(/^[a-z0-9]{6,24}$/, 'A share slug is 6 to 24 lowercase letters and digits.')
  .describe('The route\'s share slug: the last path segment of a go-splitt.com/r/<slug> link.');

// ── Route library ────────────────────────────────────────────────────────────

export const listMyRoutes = defineTool({
  name: 'list_my_routes',
  title: 'My route library',
  description:
    'List the reusable routes/trails in the signed-in vendor\'s library (newest first) with distance, elevation, difficulty, activity type, share slug ' +
    'and how many listings/experiences each is attached to. Active routes only unless includeArchived is true. Use get_route for one route\'s full detail.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: { includeArchived: z.boolean().optional().describe('Also return archived routes (default false).') },
  annotations: READ,
  handler: async ({ includeArchived }, ctx) => fromResult(await routesApi.listMine(token(ctx), includeArchived ?? false)),
});

export const getRoute = defineTool({
  name: 'get_route',
  title: 'Get a library route',
  description:
    'Full detail of one route in the vendor\'s library: track geometry, elevation profile, computed metrics, cues, points of interest, hazards, permits, ' +
    'status, moderation status and linked counts. Vendor-owned routes only; for a shared public route use get_public_route.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: { routeId: uuid('route') },
  annotations: READ,
  handler: async ({ routeId }, ctx) => fromResult(await routesApi.getOne(token(ctx), routeId)),
});

export const createRoute = defineTool({
  name: 'create_route',
  title: 'Create a library route',
  description:
    'Add a reusable route/trail to the vendor\'s library. Required: name and activityType; pass geometry as [lng, lat, elevationM?] points to get a real map, ' +
    'distance, elevation and a computed difficulty/duration (or pin your own). The route is active immediately but shows on a listing only after ' +
    'attach_route_to_listing. To import a GPX file use import_gpx_route instead.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: {
    name: routeName,
    activityType,
    summary: routeSummary.optional(),
    difficulty: routeDifficulty.optional(),
    estimatedDurationMinutes: routeDuration.optional(),
    ...routeOptionalFields,
  },
  annotations: WRITE,
  handler: async (args, ctx) => {
    if (args.geometry) {
      const err = geometryError(args.geometry);
      if (err) return fail(err);
    }
    return fromResult(await routesApi.create(token(ctx), args));
  },
});

export const updateRoute = defineTool({
  name: 'update_route',
  title: 'Update a library route',
  description:
    'Change fields of a route in the vendor\'s library; only the fields you pass change. Passing new geometry, activityType or unpavedPct recomputes the metrics. ' +
    'Set difficulty or estimatedDurationMinutes to null to drop a manual value and return to the computed one; set destinationId to null to clear the destination anchor. ' +
    'Changes show everywhere the route is attached.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: {
    routeId: uuid('route'),
    name: routeName.optional(),
    activityType: activityType.optional(),
    summary: routeSummary.nullable().optional(),
    difficulty: routeDifficulty.nullable().optional(),
    estimatedDurationMinutes: routeDuration.nullable().optional(),
    destinationId: z.string().uuid().nullable().optional().describe('Curated Splitt destination (park, area) this route belongs to; null clears it.'),
    ...routeOptionalFields,
  },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ routeId, ...rest }, ctx) => {
    if (Object.values(rest).every((v) => v === undefined)) return fail('Pass at least one field to update.');
    if (rest.geometry) {
      const err = geometryError(rest.geometry);
      if (err) return fail(err);
    }
    return fromResult(await routesApi.update(token(ctx), routeId, rest));
  },
});

export const deleteRoute = defineTool({
  name: 'delete_route',
  title: 'Archive or delete route',
  description:
    'Remove a route from the vendor\'s library. mode=archive (default) hides it from the library and from every listing/experience page but keeps the record; ' +
    'mode=delete_permanently erases it and is refused (409) while the route is still attached anywhere, so detach it first. Neither can be undone from here: confirm with the user first.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: {
    routeId: uuid('route'),
    mode: z.enum(['archive', 'delete_permanently']).optional().describe('Default archive.'),
  },
  annotations: DESTRUCTIVE,
  handler: async ({ routeId, mode }, ctx) => {
    const hard = mode === 'delete_permanently';
    return fromResult(await routesApi.remove(token(ctx), routeId, hard), () => (hard ? { deleted: true, routeId } : { archived: true, routeId }));
  },
});

export const importGpxRoute = defineTool({
  name: 'import_gpx_route',
  title: 'Import a GPX route',
  description:
    'Import a GPX track (the XML text of a .gpx file, up to 2 MB) into the vendor\'s route library. Splitt parses the track, simplifies it and, unless dryRun is true, ' +
    'saves it as a new route with the given activityType (name defaults to the GPX name; you may also set summary, surface, difficulty, duration, hazards, seasonality). ' +
    'dryRun returns the parsed preview (point count, distance, elevation) without saving. Files with DTDs/external entities are rejected. ' +
    'Best for small files; very large tracks are easier to import at ' + SITE_URL + '/vendor/routes/new.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: {
    gpxXml: z.string().min(20).max(MAX_GPX_BYTES).describe('The full GPX XML document text (UTF-8).'),
    activityType,
    name: routeName.optional().describe('Overrides the name found in the GPX file.'),
    summary: routeSummary.optional(),
    surface: z.enum(ROUTE_SURFACES).optional(),
    difficulty: routeDifficulty.optional(),
    estimatedDurationMinutes: routeDuration.optional(),
    hazards: z.string().max(2000).optional(),
    seasonality: z.string().max(120).optional(),
    dryRun: z.boolean().optional().describe('Parse and preview only; do not save (default false).'),
  },
  annotations: WRITE,
  handler: async ({ gpxXml, dryRun, ...overrides }, ctx) => {
    if (dryRun) {
      return fromResult(await routesApi.importGpx(token(ctx), gpxXml), (d) => ({
        saved: false,
        draft: summarizeDraft(d?.draft),
        hint: 'Call import_gpx_route again without dryRun to save this track as a route.',
      }));
    }
    return fromResult(await routesApi.importGpxAsRoute(token(ctx), gpxXml, overrides));
  },
});

// ── Public reads ─────────────────────────────────────────────────────────────

export const getPublicRoute = defineTool({
  name: 'get_public_route',
  title: 'Shared route page',
  description:
    'Public detail of a shared Splitt route by its share slug (from a ' + SITE_URL + '/r/<slug> link or a route\'s shareSlug): name, vendor, activity, distance, ' +
    'elevation, difficulty, cues, points of interest, hazards, permits and up to four linked gear listings, plus the page URL and a GPX download URL you can give the user. ' +
    'Archived or hidden routes return not found. ' + UNTRUSTED_NOTE,
  access: 'public',
  scope: 'read',
  inputSchema: { shareSlug },
  annotations: READ,
  handler: async ({ shareSlug: slug }) =>
    fromResult(await routesApi.getPublic(slug), (d) => ({
      route: d?.route ?? d,
      pageUrl: `${SITE_URL}/r/${slug}`,
      gpxDownloadUrl: routesApi.publicGpxUrl(slug),
    })),
});

export const listListingRoutes = defineTool({
  name: 'list_listing_routes',
  title: 'Routes on a listing',
  description:
    'The routes/trails shown on a gear listing\'s page: library routes attached by the vendor (with shareSlug, metrics and map data) followed by legacy per-listing ' +
    'route cards (source "legacy"). Public for published listings; the signed-in owner also sees a draft listing\'s routes. ' + UNTRUSTED_NOTE,
  access: 'public',
  scope: 'read',
  inputSchema: { listingId: uuid('listing') },
  annotations: READ,
  handler: async ({ listingId }, ctx) => fromResult(await routesApi.listListingRoutes(listingId, ctx.token)),
});

// ── Listing <-> library route links ──────────────────────────────────────────

export const attachRouteToListing = defineTool({
  name: 'attach_route_to_listing',
  title: 'Attach route to listing',
  description:
    'Show one of the vendor\'s library routes on one of their listings (appended after the routes already attached; at most ' + MAX_LINKED_ROUTES_PER_LISTING +
    ' per listing). Already attached is a no-op. Both the route and the listing must belong to the signed-in vendor. Use set_listing_routes to reorder or replace the whole set.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: { listingId: uuid('listing'), routeId: uuid('library route') },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ listingId, routeId }, ctx) => fromResult(await routesApi.attachToListing(token(ctx), listingId, routeId)),
});

export const setListingRoutes = defineTool({
  name: 'set_listing_routes',
  title: 'Set listing routes',
  description:
    'Replace the full ordered set of library routes attached to a listing (up to ' + MAX_LINKED_ROUTES_PER_LISTING + ', shown in the order given; an empty list detaches all). ' +
    'Legacy per-listing route cards are not affected. Every route must belong to the signed-in vendor, who must own the listing. Returns the routes now shown on the listing.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: {
    listingId: uuid('listing'),
    routeIds: z.array(z.string().uuid()).max(MAX_LINKED_ROUTES_PER_LISTING).describe('Library route ids in display order; [] clears all attachments.'),
  },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ listingId, routeIds }, ctx) => {
    if (new Set(routeIds).size !== routeIds.length) return fail('Each route may only be listed once.');
    return fromResult(await routesApi.setListingRoutes(token(ctx), listingId, routeIds));
  },
});

export const detachRouteFromListing = defineTool({
  name: 'detach_route_from_listing',
  title: 'Detach route from listing',
  description:
    'Stop showing a library route on a listing. The route itself stays in the vendor\'s library and on any other listing. Returns wasAttached:false if it was not attached. ' +
    'For a legacy per-listing route card use delete_listing_route instead. Confirm with the user first.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: { listingId: uuid('listing'), routeId: uuid('library route') },
  annotations: DESTRUCTIVE,
  handler: async ({ listingId, routeId }, ctx) => fromResult(await routesApi.detachFromListing(token(ctx), listingId, routeId)),
});

// ── Legacy per-listing route cards ───────────────────────────────────────────

const legacyRouteFields = {
  summary: z.string().max(4000).optional(),
  difficulty: z.enum(LEGACY_ROUTE_DIFFICULTIES).optional(),
  distanceKm: z.number().min(0).max(100000).optional(),
  elevationGainM: z.number().int().min(0).max(100000).optional(),
  estimatedDurationMinutes: z.number().int().min(0).max(100000).optional(),
  gpxUrl: httpsUrl(500).optional().describe('Link to a downloadable GPX (https only; shown as an outbound link, never fetched).'),
  mapUrl: httpsUrl(500).optional().describe('Link to an external map (https only).'),
  startLatitude: latitude.optional(),
  startLongitude: longitude.optional(),
  waypoints: z
    .array(z.object({ name: z.string().min(1).max(120), lat: latitude, lng: longitude, note: z.string().max(280).optional() }))
    .max(50)
    .optional(),
  permits: z.array(permitSchema).max(20).optional(),
  seasonality: z.string().max(120).optional(),
  hazards: z.array(z.string().min(1).max(200)).max(20).optional().describe('Short hazard notes, one per entry.'),
  sortOrder: z.number().int().min(0).max(1000).optional(),
  status: z.enum(LEGACY_ROUTE_STATUSES).optional().describe('draft (hidden, default) or published (shown on the listing page).'),
};

export const createListingRoute = defineTool({
  name: 'create_listing_route',
  title: 'Add legacy route card',
  description:
    'Add a legacy "Routes & permits" card to one of the vendor\'s listings: a text-and-links trail description (title, difficulty, distance, GPX/map links, waypoints, ' +
    'permits, hazards) that lives on that listing only and starts as a draft until status is published. For a reusable route with a real map track prefer ' +
    'create_route or import_gpx_route plus attach_route_to_listing.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: { listingId: uuid('listing'), title: z.string().min(1).max(160), ...legacyRouteFields },
  annotations: WRITE,
  handler: async ({ listingId, ...input }, ctx) => fromResult(await routesApi.createListingRoute(token(ctx), listingId, input)),
});

export const updateListingRoute = defineTool({
  name: 'update_listing_route',
  title: 'Update legacy route card',
  description:
    'Change fields of a legacy per-listing route card (only the fields you pass change), including publishing it with status=published. ' +
    'Cards curated by Splitt editors are read-only for the vendor. Card ids come from list_listing_routes (source "legacy").',
  access: 'vendor',
  scope: 'listings',
  inputSchema: { listingId: uuid('listing'), routeId: uuid('legacy route card'), title: z.string().min(1).max(160).optional(), ...legacyRouteFields },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ listingId, routeId, ...rest }, ctx) => {
    if (Object.values(rest).every((v) => v === undefined)) return fail('Pass at least one field to update.');
    return fromResult(await routesApi.updateListingRoute(token(ctx), listingId, routeId, rest));
  },
});

export const deleteListingRoute = defineTool({
  name: 'delete_listing_route',
  title: 'Delete legacy route card',
  description:
    'Permanently delete a legacy per-listing route card from one of the vendor\'s listings. Cannot be undone; Splitt-curated cards cannot be deleted by the vendor. ' +
    'For library routes use detach_route_from_listing. Confirm with the user first.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: { listingId: uuid('listing'), routeId: uuid('legacy route card') },
  annotations: DESTRUCTIVE,
  handler: async ({ listingId, routeId }, ctx) =>
    fromResult(await routesApi.deleteListingRoute(token(ctx), listingId, routeId), () => ({ deleted: true, listingId, routeId })),
});

export const routeTools = [
  listMyRoutes,
  getRoute,
  createRoute,
  updateRoute,
  deleteRoute,
  importGpxRoute,
  getPublicRoute,
  listListingRoutes,
  attachRouteToListing,
  setListingRoutes,
  detachRouteFromListing,
  createListingRoute,
  updateListingRoute,
  deleteListingRoute,
];
