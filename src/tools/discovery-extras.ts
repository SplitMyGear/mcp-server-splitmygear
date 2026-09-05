/**
 * Discovery extras: saved searches (search alerts), saved trips, the public
 * trip-intelligence planner (`/trips/*`, `/ai/plan-trip`), curated
 * destinations and the category catalogue. Thin clients of the backend REST
 * routes; only DTO fields are ever sent (the backend's global ValidationPipe
 * rejects undeclared fields with a 400), and every user-scoped call forwards
 * the signed-in user's own JWT.
 */
import { call, compact, qs } from './_shared';

export const SEARCH_ALERT_FREQUENCIES = ['instant', 'daily', 'weekly'] as const;
export type SearchAlertFrequency = (typeof SEARCH_ALERT_FREQUENCIES)[number];

/** `CreateSearchAlertDto` (search-alerts/dto/search-alert.dto.ts). */
export interface SearchAlertInput {
  name: string;
  searchQuery?: string;
  category?: string;
  minPrice?: number;
  maxPrice?: number;
  location?: string;
  latitude?: number;
  longitude?: number;
  radiusKm?: number;
  frequency?: SearchAlertFrequency;
  isActive?: boolean;
}

/** `CreateSavedTripDto` (saved-trips/dto/create-saved-trip.dto.ts). */
export interface SavedTripInput {
  destination: string;
  numPeople: number;
  activities: string[];
  startDate?: string;
  endDate?: string;
  duration?: number;
  planSnapshot?: { tripSummary?: string; totalEstimatedBudget?: string; source?: 'board' | 'fallback' };
}

/** `PlanTripQueryDto` (trips/dto/trips.dto.ts): the public trip board. */
export interface PlanTripQuery {
  destination: string;
  activities: string[];
  start?: string;
  end?: string;
  days?: number;
  people?: number;
}

export const POI_RECIPES = ['trails-bike', 'trails-hike', 'food-drink', 'on-water', 'parks-views', 'camping'] as const;
export type PoiRecipe = (typeof POI_RECIPES)[number];

/** `PoisQueryDto`. */
export interface PoiQuery {
  lat: number;
  lng: number;
  recipe: PoiRecipe;
  radius?: number;
}

/** `PlanTripDto` (ai/dto/ai.dto.ts): the AI gear-plan generator. */
export interface AiTripPlanInput {
  destination: string;
  duration: number;
  numPeople: number;
  activities: string[];
  experienceLevel?: 'beginner' | 'intermediate' | 'advanced';
}

/** `EmailTripPlanDto` (trips/dto/trips.dto.ts). No recipient field: the backend mails the caller's own address. */
export interface EmailTripPlanInput {
  destination: string;
  numPeople: number;
  activities?: string[];
  startDate?: string;
  endDate?: string;
  duration?: number;
  tripSummary?: string;
  totalEstimatedBudget?: string;
  gearCategories?: Array<{ category: string; priority?: string; itemCount?: number }>;
  poiHighlights?: Array<{ name: string; group?: string }>;
  source?: 'board' | 'fallback';
}

export const discoveryExtrasTools = {
  // ── Search alerts (saved searches): JwtAuthGuard, owner-scoped by the service ──

  listSearchAlerts(token: string) {
    return call('GET', '/search-alerts', { token });
  },

  getSearchAlert(token: string, alertId: string) {
    return call('GET', `/search-alerts/${alertId}`, { token });
  },

  createSearchAlert(token: string, input: SearchAlertInput) {
    return call('POST', '/search-alerts', { token, body: compact(input) });
  },

  updateSearchAlert(token: string, alertId: string, input: Partial<SearchAlertInput>) {
    return call('PUT', `/search-alerts/${alertId}`, { token, body: compact(input) });
  },

  /** Flips isActive; the response carries the new state. */
  toggleSearchAlert(token: string, alertId: string) {
    return call('POST', `/search-alerts/${alertId}/toggle`, { token, body: {} });
  },

  deleteSearchAlert(token: string, alertId: string) {
    return call('DELETE', `/search-alerts/${alertId}`, { token });
  },

  // ── Saved trips: JwtAuthGuard on the controller ──────────────────────────

  listSavedTrips(token: string) {
    return call('GET', '/saved-trips', { token });
  },

  saveTrip(token: string, input: SavedTripInput) {
    return call('POST', '/saved-trips', { token, body: compact(input) });
  },

  deleteSavedTrip(token: string, tripId: string) {
    return call('DELETE', `/saved-trips/${tripId}`, { token });
  },

  // ── Trip intelligence (public, throttled) ────────────────────────────────

  /** The trip board: geocoded destination, weather, nearby gear + experiences, POI groups and an itinerary skeleton. */
  planTrip(input: PlanTripQuery) {
    const { destination, activities, start, end, days, people } = input;
    return call('GET', `/trips/plan${qs({ destination, activities: activities.join(','), start, end, days, people })}`);
  },

  getTripPois(input: PoiQuery) {
    return call('GET', `/trips/pois${qs({ lat: input.lat, lng: input.lng, recipe: input.recipe, radius: input.radius })}`);
  },

  getTripIdeas(listingId: string, start?: string, end?: string) {
    return call('GET', `/trips/ideas/${listingId}${qs({ start, end })}`);
  },

  suggestLocations(q: string) {
    return call('GET', `/trips/geocode-suggest${qs({ q })}`);
  },

  /** Emails the plan to the signed-in user's own address (backend bucket: 5 sends per 10 minutes). */
  emailTripPlan(token: string, input: EmailTripPlanInput) {
    return call('POST', '/trips/email-plan', { token, body: compact(input) });
  },

  /** AI-written gear checklist, pro tips and budget for a trip (public, may report `available: false`). */
  generateAiTripPlan(input: AiTripPlanInput) {
    return call('POST', '/ai/plan-trip', { body: compact(input), timeoutMs: 25_000 });
  },

  // ── Destinations (public) ────────────────────────────────────────────────

  listDestinations() {
    return call('GET', '/destinations');
  },

  /** `slug` must already be validated by the tool schema (lowercase slug shape); encoded defensively anyway. */
  getDestination(slug: string) {
    return call('GET', `/destinations/${encodeURIComponent(slug)}`);
  },

  // ── Categories (public) ──────────────────────────────────────────────────

  listCategories(withListingCounts = false) {
    return call('GET', withListingCounts ? '/categories/stats' : '/categories');
  },

  getCategory(categoryId: string) {
    return call('GET', `/categories/${categoryId}`);
  },

  getCategoryStats(categoryId: string) {
    return call('GET', `/categories/${categoryId}/stats`);
  },
};
