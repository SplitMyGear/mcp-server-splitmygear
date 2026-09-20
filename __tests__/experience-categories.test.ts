/**
 * Regression lock for SPLIT-1496.
 *
 * The MCP `search_experiences` tool advertised `z.string()` for `category`
 * with a Title-Case example ("Outdoor, Tours, Fitness, ..."), but the backend
 * `GET /packages` validates `category` against a fixed LOWERCASE enum and 400s
 * anything else — so every categorized experience search failed upstream.
 *
 * These tests assert the shared schema now enforces exactly the backend's
 * lowercase set. On the pre-fix `z.string()` schema, the "rejects Title-Case"
 * assertion below would fail (a string schema accepts "Outdoor").
 */
import {
  EXPERIENCE_CATEGORIES,
  experienceCategorySchema,
} from '../src/tools/experience-categories';

// The exact set the backend enumerates in its 400 message
// (GET /api/v1/packages?category=<bad> -> "category must be one of the
// following values: tours, food, outdoor, ...") — verified live on staging
// and prod on 2026-09-20.
const BACKEND_PACKAGE_CATEGORIES = [
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
];

describe('experienceCategorySchema (SPLIT-1496)', () => {
  it('advertises exactly the backend package-category enum', () => {
    expect([...EXPERIENCE_CATEGORIES].sort()).toEqual(
      [...BACKEND_PACKAGE_CATEGORIES].sort(),
    );
  });

  it('every advertised category is lowercase', () => {
    for (const c of EXPERIENCE_CATEGORIES) {
      expect(c).toBe(c.toLowerCase());
    }
  });

  it('accepts every valid lowercase category', () => {
    for (const c of BACKEND_PACKAGE_CATEGORIES) {
      expect(experienceCategorySchema.safeParse(c).success).toBe(true);
    }
  });

  it('rejects the Title-Case values the tool used to advertise (the bug)', () => {
    for (const c of ['Outdoor', 'Tours', 'Fitness']) {
      expect(experienceCategorySchema.safeParse(c).success).toBe(false);
    }
  });

  it('rejects an unknown category', () => {
    expect(experienceCategorySchema.safeParse('spelunking').success).toBe(false);
  });
});
