import {
  LISTING_CATEGORIES,
  LISTING_CATEGORY_IDS,
  STAY_CATEGORIES,
} from '@/tools/listing-categories';

/**
 * SPLIT-1500 rail.
 *
 * The advertised taxonomy had drifted five entries behind the backend, which
 * made `ATVs` and the entire Stays vertical unreachable for any client that
 * picks a category from the `splitmygear://categories` resource.
 *
 * `EXPECTED` below is a literal transcription of the backend's
 * `LISTING_CATEGORIES` (`apps/api/src/listing/listing-categories.ts`) at
 * backend `origin/main` on 2026-09-21. The MCP cannot import from the backend,
 * so this duplication is the point: when the backend adds a category, this
 * test fails and names the delta, instead of the omission passing silently.
 */
const EXPECTED_BACKEND_CATEGORIES = [
  'E-Bikes',
  'Biking',
  'Camping',
  'RV',
  'Hiking',
  'Water Sports',
  'Winter Sports',
  'Snow Sports',
  'Climbing',
  'Surfing',
  'Fishing',
  'Golf',
  'Kayaking',
  'Skiing',
  'Tennis',
  'Boating',
  'ATVs',
  'Photography',
  'Electronics',
  'Cabins',
  'Campsites',
  'RV Sites',
  'Glamping',
  'Other',
];

/** Mirrors the backend's `STAY_CATEGORIES` (SPLIT-1266). */
const EXPECTED_STAY_CATEGORIES = ['Cabins', 'Campsites', 'RV Sites', 'Glamping'];

describe('listing categories', () => {
  it('matches the backend taxonomy exactly, in order', () => {
    expect(LISTING_CATEGORY_IDS).toEqual(EXPECTED_BACKEND_CATEGORIES);
  });

  it('includes the five that SPLIT-1500 found missing', () => {
    // Named individually so a regression says WHICH one vanished.
    for (const id of ['ATVs', 'Cabins', 'Campsites', 'RV Sites', 'Glamping']) {
      expect(LISTING_CATEGORY_IDS).toContain(id);
    }
  });

  it('flags exactly the nightly-booked stay categories', () => {
    expect(STAY_CATEGORIES).toEqual(EXPECTED_STAY_CATEGORIES);
  });

  it('keeps Camping (gear) distinct from Campsites (a bookable site)', () => {
    const camping = LISTING_CATEGORIES.find((c) => c.id === 'Camping');
    const campsites = LISTING_CATEGORIES.find((c) => c.id === 'Campsites');
    expect(camping?.stay).toBeUndefined();
    expect(campsites?.stay).toBe(true);
  });

  it('advertises canonical Title-Case ids, never the lowercase browse-filter form', () => {
    // The frontend submits lowercase hyphenated values (`water-sports`,
    // `e-bikes`) which the backend normalises on write. Those are valid input
    // but not canonical, and the MCP must not be the thing that suggests them
    // (SPLIT-685). Hyphens themselves are fine — `E-Bikes` is canonical — so
    // the invariant is that an id is never equal to its own lowercasing.
    for (const { id } of LISTING_CATEGORIES) {
      expect(id).not.toEqual(id.toLowerCase());
    }
  });

  it('gives every category a distinct id and a non-empty icon', () => {
    expect(new Set(LISTING_CATEGORY_IDS).size).toBe(LISTING_CATEGORY_IDS.length);
    for (const { id, name, icon } of LISTING_CATEGORIES) {
      expect(name).toBeTruthy();
      expect(icon.length).toBeGreaterThan(0);
      expect(id).toBeTruthy();
    }
  });
});
