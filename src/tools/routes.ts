/**
 * Splitt Routes: the vendor's reusable route/trail library (Routes v2 under
 * `/routes`), public shared-route reads (`/routes/public/:shareSlug`), the
 * v2 listing<->route links (`PUT /rentals/:id/routes`, a full replace of at
 * most 5 links) and the legacy per-listing "Routes & permits" cards
 * (`POST/PUT/DELETE /rentals/:id/routes[/:routeId]`).
 *
 * Every write forwards the signed-in vendor's own JWT; the backend's
 * VendorOrPrivilegedGuard / RolesGuard enforce ownership. Only DTO fields are
 * ever sent (the backend's global ValidationPipe rejects undeclared fields
 * with a 400) and the curator-only on-behalf `vendorId` is never sent: the
 * acting vendor is always the one the token belongs to.
 */
import { backendBaseUrl } from '@/lib/backend-client';
import { call, compact, qs, type Result } from './_shared';

// ── Backend enums (routes/route.entity.ts, listing/listing-route.entity.ts) ──

export const ROUTE_ACTIVITY_TYPES = [
  'road_cycling', 'gravel', 'ebike', 'mtb', 'hike', 'trail_run', 'atv_offroad', 'snowmobile', 'jet_ski', 'kayak_paddle', 'ski_tour', 'other',
] as const;
export type RouteActivityType = (typeof ROUTE_ACTIVITY_TYPES)[number];

export const ROUTE_SURFACES = ['paved', 'mixed', 'unpaved', 'water', 'snow'] as const;
export type RouteSurface = (typeof ROUTE_SURFACES)[number];

export const ROUTE_DIFFICULTY_LEVELS = ['easy', 'moderate', 'challenging', 'expert'] as const;
export type RouteDifficultyLevel = (typeof ROUTE_DIFFICULTY_LEVELS)[number];

export const ROUTE_POI_KINDS = [
  'trailhead', 'parking', 'viewpoint', 'water', 'restroom', 'camping', 'hazard', 'food', 'fuel', 'repair', 'rest', 'launch', 'custom',
] as const;
export type RoutePoiKind = (typeof ROUTE_POI_KINDS)[number];

/** Sources a vendor may stamp on a NEW route ('rwgps' is historical-only on the backend). */
export const ROUTE_CREATE_SOURCES = ['drawn', 'gpx'] as const;
export type RouteCreateSource = (typeof ROUTE_CREATE_SOURCES)[number];

/** Legacy per-listing route card enums (v1 `ListingRoute`). */
export const LEGACY_ROUTE_DIFFICULTIES = ['easy', 'moderate', 'difficult', 'expert'] as const;
export type LegacyRouteDifficulty = (typeof LEGACY_ROUTE_DIFFICULTIES)[number];
export const LEGACY_ROUTE_STATUSES = ['draft', 'published'] as const;
export type LegacyRouteStatus = (typeof LEGACY_ROUTE_STATUSES)[number];

/** `SetRouteLinksDto.routeIds` is `@ArrayMaxSize(5)`. */
export const MAX_LINKED_ROUTES_PER_LISTING = 5;
/** `POST /routes/import/gpx` multer limit and `RouteImportService` cap. */
export const MAX_GPX_BYTES = 2 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 20_000;

// ── Input shapes (mirror routes/dto/route.dto.ts and listing/dto/listing-route.dto.ts) ──

export interface RoutePoiInput {
  name: string;
  lat: number;
  lng: number;
  kind: RoutePoiKind;
  note?: string;
}

export interface RouteCueInput {
  /** Distance from the route start, in meters. */
  dM: number;
  text: string;
  type?: string;
  lat?: number;
  lng?: number;
}

export interface RoutePermitInput {
  name: string;
  authority?: string;
  url?: string;
  required: boolean;
  cost?: string;
  notes?: string;
}

/** Body for POST /routes (`CreateRouteDto` minus the curator-only `vendorId`). */
export interface RouteInput {
  name: string;
  activityType: RouteActivityType;
  summary?: string;
  /** Ordered [lng, lat, elevationM?] tuples; every metric is server-derived from it. */
  geometry?: number[][];
  surface?: RouteSurface;
  unpavedPct?: number;
  difficulty?: RouteDifficultyLevel;
  estimatedDurationMinutes?: number;
  cuePoints?: RouteCueInput[];
  pois?: RoutePoiInput[];
  hazards?: string;
  seasonality?: string;
  permits?: RoutePermitInput[];
  source?: RouteCreateSource;
  sourceRef?: string;
}

/**
 * Body for PATCH /routes/:id (`UpdateRouteDto`). `null` on difficulty /
 * estimatedDurationMinutes reverts the field to the server computation;
 * `null` on destinationId clears the destination anchor.
 */
export interface RouteUpdateInput extends Partial<Omit<RouteInput, 'summary' | 'difficulty' | 'estimatedDurationMinutes'>> {
  summary?: string | null;
  difficulty?: RouteDifficultyLevel | null;
  estimatedDurationMinutes?: number | null;
  destinationId?: string | null;
}

export interface LegacyWaypointInput {
  name: string;
  lat: number;
  lng: number;
  note?: string;
}

/** Body for POST /rentals/:id/routes (`CreateListingRouteDto`, the legacy per-listing card). */
export interface ListingRouteInput {
  title: string;
  summary?: string;
  difficulty?: LegacyRouteDifficulty;
  distanceKm?: number;
  elevationGainM?: number;
  estimatedDurationMinutes?: number;
  gpxUrl?: string;
  mapUrl?: string;
  startLatitude?: number;
  startLongitude?: number;
  waypoints?: LegacyWaypointInput[];
  permits?: RoutePermitInput[];
  seasonality?: string;
  hazards?: string[];
  sortOrder?: number;
  status?: LegacyRouteStatus;
}

/** What `POST /routes/import/gpx` returns: a parsed, NOT yet persisted route. */
export interface RouteImportDraft {
  name: string;
  geometry: number[][];
  cuePoints: RouteCueInput[] | null;
  pois: RoutePoiInput[] | null;
  surface: RouteSurface | null;
  unpavedPct: number | null;
  source: 'gpx';
  sourceRef: string | null;
  preview: Record<string, unknown>;
}
export interface GpxImportResponse {
  success?: boolean;
  draft?: RouteImportDraft;
}

/** Fields a vendor may set when saving an imported GPX straight into the library. */
export interface GpxImportOverrides {
  activityType: RouteActivityType;
  name?: string;
  summary?: string;
  surface?: RouteSurface;
  difficulty?: RouteDifficultyLevel;
  estimatedDurationMinutes?: number;
  hazards?: string;
  seasonality?: string;
}

/** Minimal shape of a row in `GET /rentals/:id/routes` (v2 links merged with legacy cards). */
interface PublicRouteRow {
  id: string;
  source?: string;
  shareSlug?: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Fast client-side check mirroring `RoutesService.validateAndSimplifyGeometry`; returns a message or null. */
export function geometryError(geometry: number[][]): string | null {
  for (let i = 0; i < geometry.length; i++) {
    const point = geometry[i];
    if (!Array.isArray(point) || point.length < 2 || point.length > 3) {
      return `geometry[${i}] must be a [lng, lat] or [lng, lat, elevationM] tuple.`;
    }
    const [lng, lat, ele] = point;
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
      return `geometry[${i}]: longitude must be between -180 and 180 (points are [lng, lat, elevationM?], longitude first).`;
    }
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      return `geometry[${i}]: latitude must be between -90 and 90 (points are [lng, lat, elevationM?], longitude first).`;
    }
    if (point.length === 3 && !Number.isFinite(ele)) {
      return `geometry[${i}]: elevation must be a finite number when present.`;
    }
  }
  return null;
}

/** The import draft without its (possibly huge) geometry, for transcripts. */
export function summarizeDraft(draft: RouteImportDraft | undefined) {
  if (!draft) return null;
  const { geometry, ...rest } = draft;
  const points = Array.isArray(geometry) ? geometry : [];
  return {
    ...rest,
    pointCount: points.length,
    start: points[0] ?? null,
    end: points[points.length - 1] ?? null,
  };
}

function routeRows(data: unknown): PublicRouteRow[] {
  const routes = (data as { routes?: unknown } | null | undefined)?.routes;
  return Array.isArray(routes) ? (routes as PublicRouteRow[]) : [];
}

/** Ids of the v2 library routes linked to a listing (legacy cards are synthesized with source 'legacy'). */
function linkedLibraryRouteIds(rows: PublicRouteRow[]): string[] {
  return rows.filter((r) => r.source !== 'legacy').map((r) => r.id);
}

/** Mirrors `extractErrorMessage` in `@/lib/backend-client` for the multipart path. */
function backendErrorMessage(parsed: unknown, status: number): string {
  if (parsed && typeof parsed === 'object') {
    const body = parsed as { message?: unknown; error?: unknown };
    if (Array.isArray(body.message)) {
      return body.message.filter((m) => typeof m === 'string').join('; ') || `Request failed (${status})`;
    }
    if (typeof body.message === 'string') return body.message;
    if (typeof body.error === 'string') return body.error;
  }
  return `Backend request failed (${status})`;
}

// ── Route library (/routes) ─────────────────────────────────────────────────

function listMine(token: string, includeArchived = false) {
  return call('GET', `/routes/mine${qs({ includeArchived: includeArchived ? 'true' : undefined })}`, { token });
}

function getOne(token: string, routeId: string) {
  return call('GET', `/routes/${routeId}`, { token });
}

function create(token: string, input: RouteInput) {
  return call<{ success?: boolean; route?: unknown }>('POST', '/routes', { token, body: compact(input) });
}

function update(token: string, routeId: string, input: RouteUpdateInput) {
  return call('PATCH', `/routes/${routeId}`, { token, body: compact(input) });
}

/** Default archives (hidden from the library and public pages); `hard` permanently deletes an UNLINKED route (409 otherwise). */
function remove(token: string, routeId: string, hard = false) {
  return call('DELETE', `/routes/${routeId}${hard ? '?hard=true' : ''}`, { token });
}

/**
 * Multipart `POST /routes/import/gpx` (field `file`). The backend parses the
 * XML transiently and returns a draft; nothing is persisted. The GPX text is
 * never logged.
 */
async function importGpx(token: string, gpxXml: string): Promise<Result<GpxImportResponse>> {
  if (Buffer.byteLength(gpxXml, 'utf8') > MAX_GPX_BYTES) {
    return { ok: false, error: 'GPX file must be 2 MB or smaller.', status: 413 };
  }
  const form = new FormData();
  form.append('file', new Blob([gpxXml], { type: 'application/gpx+xml' }), 'route.gpx');

  let response: Response;
  try {
    response = await fetch(`${backendBaseUrl()}/routes/import/gpx`, {
      method: 'POST',
      // No Content-Type here: fetch sets the multipart boundary itself.
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      ok: false,
      error: isTimeout ? 'GPX import timed out; try a smaller file.' : 'GPX import failed (network error talking to Splitt).',
      status: isTimeout ? 504 : 502,
    };
  }

  const raw = await response.text();
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!response.ok) return { ok: false, error: backendErrorMessage(parsed, response.status), status: response.status };
  return { ok: true, data: (parsed ?? {}) as GpxImportResponse };
}

/** Parse a GPX file and save the result as a new library route in one go (what the web Route Studio does). */
async function importGpxAsRoute(token: string, gpxXml: string, overrides: GpxImportOverrides) {
  const imported = await importGpx(token, gpxXml);
  if (!imported.ok) return imported;
  const draft = imported.data.draft;
  if (!draft || !Array.isArray(draft.geometry) || draft.geometry.length < 2) {
    return { ok: false as const, error: 'Splitt could not find a usable track in that GPX file.', status: 400 };
  }
  const { activityType, name, ...rest } = overrides;
  const created = await create(token, {
    name: (name ?? draft.name ?? 'Imported route').slice(0, 140),
    activityType,
    geometry: draft.geometry,
    cuePoints: draft.cuePoints ?? undefined,
    pois: draft.pois ?? undefined,
    surface: rest.surface ?? draft.surface ?? undefined,
    unpavedPct: draft.unpavedPct ?? undefined,
    summary: rest.summary,
    difficulty: rest.difficulty,
    estimatedDurationMinutes: rest.estimatedDurationMinutes,
    hazards: rest.hazards,
    seasonality: rest.seasonality,
    source: 'gpx',
    sourceRef: draft.sourceRef ?? undefined,
  });
  if (!created.ok) return created;
  return { ok: true as const, data: { ...created.data, import: { pointCount: draft.geometry.length, preview: draft.preview } } };
}

// ── Public reads ─────────────────────────────────────────────────────────────

function getPublic(shareSlug: string) {
  return call<{ route?: unknown }>('GET', `/routes/public/${encodeURIComponent(shareSlug)}`);
}

/** Unauthenticated GPX download for a shared route (served by the backend with a Content-Disposition attachment). */
function publicGpxUrl(shareSlug: string): string {
  return `${backendBaseUrl()}/routes/public/${encodeURIComponent(shareSlug)}/gpx`;
}

/** Public (OptionalJwtAuthGuard): forwarding a token lets a listing's owner read routes on a draft listing. */
function listListingRoutes(listingId: string, token?: string) {
  return call<{ routes?: unknown[] }>('GET', `/rentals/${listingId}/routes`, { token });
}

// ── Listing <-> library route links (v2) ─────────────────────────────────────

/** Full replace of the listing's library-route links, in display order (legacy cards are untouched). */
function setListingRoutes(token: string, listingId: string, routeIds: string[]) {
  return call<{ routes?: unknown[] }>('PUT', `/rentals/${listingId}/routes`, { token, body: { routeIds } });
}

async function attachToListing(token: string, listingId: string, routeId: string) {
  const current = await listListingRoutes(listingId, token);
  if (!current.ok) return current;
  const rows = routeRows(current.data);
  const linked = linkedLibraryRouteIds(rows);
  if (linked.includes(routeId)) {
    return { ok: true as const, data: { attached: true, alreadyAttached: true, routes: rows } };
  }
  if (linked.length >= MAX_LINKED_ROUTES_PER_LISTING) {
    return {
      ok: false as const,
      error: `A listing can carry at most ${MAX_LINKED_ROUTES_PER_LISTING} library routes; detach one first (detach_route_from_listing).`,
      status: 400,
    };
  }
  const saved = await setListingRoutes(token, listingId, [...linked, routeId]);
  if (!saved.ok) return saved;
  return { ok: true as const, data: { attached: true, alreadyAttached: false, routes: saved.data?.routes ?? [] } };
}

async function detachFromListing(token: string, listingId: string, routeId: string) {
  const current = await listListingRoutes(listingId, token);
  if (!current.ok) return current;
  const rows = routeRows(current.data);
  const target = rows.find((r) => r.id === routeId);
  if (target && target.source === 'legacy') {
    return {
      ok: false as const,
      error: 'That id is a legacy per-listing route card, not a library link; remove it with delete_listing_route.',
      status: 400,
    };
  }
  const linked = linkedLibraryRouteIds(rows);
  if (!linked.includes(routeId)) {
    return { ok: true as const, data: { detached: false, wasAttached: false, routes: rows } };
  }
  const saved = await setListingRoutes(token, listingId, linked.filter((id) => id !== routeId));
  if (!saved.ok) return saved;
  return { ok: true as const, data: { detached: true, wasAttached: true, routes: saved.data?.routes ?? [] } };
}

// ── Legacy per-listing route cards (v1 ListingRoute) ─────────────────────────

function createListingRoute(token: string, listingId: string, input: ListingRouteInput) {
  return call('POST', `/rentals/${listingId}/routes`, { token, body: compact(input) });
}

function updateListingRoute(token: string, listingId: string, routeId: string, input: Partial<ListingRouteInput>) {
  return call('PUT', `/rentals/${listingId}/routes/${routeId}`, { token, body: compact(input) });
}

function deleteListingRoute(token: string, listingId: string, routeId: string) {
  return call('DELETE', `/rentals/${listingId}/routes/${routeId}`, { token });
}

export const routesApi = {
  listMine,
  getOne,
  create,
  update,
  remove,
  importGpx,
  importGpxAsRoute,
  getPublic,
  publicGpxUrl,
  listListingRoutes,
  setListingRoutes,
  attachToListing,
  detachFromListing,
  createListingRoute,
  updateListingRoute,
  deleteListingRoute,
};
