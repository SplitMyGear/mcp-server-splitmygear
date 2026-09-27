/**
 * Canonical listing categories, mirroring the backend's `LISTING_CATEGORIES`
 * (`apps/api/src/listing/listing-categories.ts`).
 *
 * The ids ARE the Title-Case values the API stores and expects; lowercase or
 * hyphenated variants are normalised server-side but create confusion here, so
 * the MCP always advertises canonical casing (SPLIT-685).
 *
 * SPLIT-1500: this list had drifted five entries behind the backend. It was
 * missing `ATVs` (added by SPLIT-1007 for the motorized off-road fleet, which
 * had previously been filed under `Other`) and the four Stays categories added
 * by SPLIT-1266. Because an LLM client picks a category from the
 * `splitmygear://categories` resource, those five were unreachable through the
 * MCP entirely — an entire vertical could not be searched. Keeping the list in
 * one module, consumed by the resource, is what stops it drifting again.
 *
 * Two caveats worth knowing before changing this file:
 *
 *  1. The backend's static list is a FALLBACK member of a live union
 *     (`CategoryRegistryService` = static ∪ active DB rows), so an admin can
 *     create a category that is valid on the API but absent here. That is why
 *     the `category` tool inputs stay `z.string()` rather than a hard enum:
 *     a closed enum here would reject a category the backend accepts. This
 *     resource is advisory — the backend remains the validator.
 *  2. The four `stay: true` entries are lodging/sites, not gear, and the
 *     backend enforces that they pair with `bookingType: 'nightly'` and that
 *     gear categories never do (`stay-listing.validator.ts`). Flagging them
 *     lets a client tell the two apart; note `Camping` is camping GEAR for
 *     rent, whereas `Campsites` is a bookable site.
 */
export const LISTING_CATEGORY_IDS = [
  'E-Bikes', 'Biking', 'Camping', 'RV', 'Hiking', 'Water Sports', 'Winter Sports',
  'Snow Sports', 'Climbing', 'Surfing', 'Fishing', 'Golf', 'Kayaking', 'Skiing',
  'Tennis', 'Boating', 'ATVs', 'Photography', 'Electronics', 'Cabins', 'Campsites',
  'RV Sites', 'Glamping', 'Other',
] as const;

export type ListingCategoryId = (typeof LISTING_CATEGORY_IDS)[number];

export interface ListingCategory {
  /** Canonical Title-Case value the API stores and filters on. */
  id: ListingCategoryId;
  name: string;
  icon: string;
  /** True for the nightly-booked lodging/site categories (SPLIT-1266). */
  stay?: boolean;
}

export const LISTING_CATEGORIES: readonly ListingCategory[] = [
  { id: 'E-Bikes', name: 'E-Bikes', icon: '🚴' },
  { id: 'Biking', name: 'Biking', icon: '🚵' },
  { id: 'Camping', name: 'Camping', icon: '🏕️' },
  { id: 'RV', name: 'RV', icon: '🚐' },
  { id: 'Hiking', name: 'Hiking', icon: '🥾' },
  { id: 'Water Sports', name: 'Water Sports', icon: '🚣' },
  { id: 'Winter Sports', name: 'Winter Sports', icon: '⛷️' },
  { id: 'Snow Sports', name: 'Snow Sports', icon: '🏂' },
  { id: 'Climbing', name: 'Climbing', icon: '🧗' },
  { id: 'Surfing', name: 'Surfing', icon: '🏄' },
  { id: 'Fishing', name: 'Fishing', icon: '🎣' },
  { id: 'Golf', name: 'Golf', icon: '⛳' },
  { id: 'Kayaking', name: 'Kayaking', icon: '🛶' },
  { id: 'Skiing', name: 'Skiing', icon: '🎿' },
  { id: 'Tennis', name: 'Tennis', icon: '🎾' },
  { id: 'Boating', name: 'Boating', icon: '⛵' },
  { id: 'ATVs', name: 'ATVs', icon: '🛻' },
  { id: 'Photography', name: 'Photography', icon: '📷' },
  { id: 'Electronics', name: 'Electronics', icon: '🔌' },
  { id: 'Cabins', name: 'Cabins', icon: '🛖', stay: true },
  { id: 'Campsites', name: 'Campsites', icon: '⛺', stay: true },
  { id: 'RV Sites', name: 'RV Sites', icon: '🅿️', stay: true },
  { id: 'Glamping', name: 'Glamping', icon: '✨', stay: true },
  { id: 'Other', name: 'Other', icon: '🎒' },
] as const;

/** The nightly-booked subset, mirroring the backend's `STAY_CATEGORIES`. */
export const STAY_CATEGORIES: readonly string[] = LISTING_CATEGORIES.filter(
  (c) => c.stay,
).map((c) => c.id);

