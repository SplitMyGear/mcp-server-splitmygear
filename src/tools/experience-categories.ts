import { z } from 'zod';

/**
 * Experience (package) categories accepted by the backend `GET /packages`
 * `category` query parameter.
 *
 * The backend validates this parameter against this EXACT lowercase set and
 * returns 400 for anything else — including Title-Case values such as
 * "Outdoor". The MCP `search_experiences` tool previously advertised
 * `z.string()` with a Title-Case example, so every categorized experience
 * search failed upstream (SPLIT-1496). This shared enum keeps the tool's
 * advertised/enforced contract identical to the backend's.
 *
 * Keep this in sync with the backend `PackageCategory` enum. Note this is
 * intentionally distinct from the Title-Case *listing* categories advertised
 * by `search_listings` (that convention is correct there).
 */
export const EXPERIENCE_CATEGORIES = [
  'tours',
  'food',
  'outdoor',
  'arts',
  'fitness',
  'wellness',
  'music',
  'sports',
  'workshop',
  'photography',
  'other',
] as const;

export const experienceCategorySchema = z.enum(EXPERIENCE_CATEGORIES);
