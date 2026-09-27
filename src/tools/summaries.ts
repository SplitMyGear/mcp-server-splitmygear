/**
 * Summary rows for the list tools (list_incoming_bookings, list_my_bookings,
 * list_my_listings, search_listings).
 *
 * A list answers "which ones": the model scans ids, status, dates, money and who
 * is involved, then opens one record with the matching get_* tool
 * (get_booking_status, get_listing_details). The backend's list endpoints return
 * full records instead, and every booking embeds the whole listing it is for:
 * two bookings came to about 10 KB, so a busy vendor's page of bookings reached
 * the result budget after a dozen rows (measured 2026-09-27 against the real
 * backend, driven by an LLM acting as a vendor).
 *
 * These helpers shrink only the known-heavy nested records and drop empty
 * values. Every other field passes through unchanged, so a field the backend
 * adds later still reaches the model. Shortened values get names that say so
 * (`descriptionPreview`, `firstImageUrl`): a model editing a listing must never
 * mistake a preview for the full value and write it back.
 */

type Row = Record<string, unknown>;

/** Characters of a listing description kept in a summary (the full text is in get_listing_details). */
export const DESCRIPTION_PREVIEW_CHARS = 240;

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** No information in a summary: null, undefined, '' and []. `false` and `0` are values and stay. */
function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

/**
 * A copy of `row` without empty values and without the `drop` keys. A JSON key named
 * `__proto__` is never a field, and assigning it would re-parent the copy into an object
 * the secret scrub does not walk (see secrets.ts), so it is not copied.
 */
function withoutEmpty(row: Row, drop: readonly string[] = []): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (key !== '__proto__' && !isEmpty(value) && !drop.includes(key)) out[key] = value;
  }
  return out;
}

/** Only the named, non-empty fields of a nested record; undefined when none is left. */
function pick(value: unknown, keys: readonly string[]): Row | undefined {
  if (!isRow(value)) return undefined;
  const out: Row = {};
  for (const key of keys) if (!isEmpty(value[key])) out[key] = value[key];
  return Object.keys(out).length ? out : undefined;
}

/** The start of a text on one line, cut on a character boundary with an ellipsis. */
function preview(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  if (flat.length <= DESCRIPTION_PREVIEW_CHARS) return flat;
  return `${Array.from(flat).slice(0, DESCRIPTION_PREVIEW_CHARS - 1).join('').trimEnd()}…`;
}

/** Booking fields that are nested records or line-by-line breakdowns; get_booking_status returns them. */
const BOOKING_DETAIL_FIELDS = ['listing', 'priceBreakdown', 'coverageDetails', 'staySnapshot', 'unitSnapshot', 'unitSnapshots', 'vendor'];

/** A booking as a list row: its own fields, with the embedded listing reduced to what identifies it. */
export function summarizeBooking(booking: unknown): unknown {
  if (!isRow(booking)) return booking;
  const out = withoutEmpty(booking, BOOKING_DETAIL_FIELDS);
  const listing = pick(booking.listing, ['id', 'name', 'category', 'timezone']);
  if (listing) out.listing = listing;
  return out;
}

/** Listing fields that are long text, media lists or the owner's profile; get_listing_details returns them. */
const LISTING_DETAIL_FIELDS = ['description', 'careGuide', 'imageUrls', 'imageFocalPoints', 'videoUrls', 'owner', 'addOns'];

/** A listing as a list row: scalar fields as they are, long text and media reduced to a preview and counts. */
export function summarizeListing(listing: unknown): unknown {
  if (!isRow(listing)) return listing;
  const out = withoutEmpty(listing, LISTING_DETAIL_FIELDS);
  const description = preview(listing.description);
  if (description) out.descriptionPreview = description;
  const images = Array.isArray(listing.imageUrls) ? listing.imageUrls : [];
  if (images.length) {
    out.imageCount = images.length;
    out.firstImageUrl = images[0];
  }
  if (Array.isArray(listing.videoUrls) && listing.videoUrls.length) out.videoCount = listing.videoUrls.length;
  if (Array.isArray(listing.addOns) && listing.addOns.length) out.addOnCount = listing.addOns.length;
  const owner = pick(listing.owner, ['id', 'storeName', 'firstName', 'isVerified', 'averageRating']);
  if (owner) out.owner = owner;
  return out;
}

export interface PageRequest {
  limit: number;
  offset: number;
  status?: string;
}

/**
 * One page of a list the backend can only page through (limit/offset, no server-side
 * status filter), as `{ count, [key]: rows, nextOffset? }`: the summarized rows that
 * match `status`, and `nextOffset` when the page came back full, because a status
 * filter over one page cannot see matches on the next one.
 */
export function pageOf(key: string, rows: unknown, page: PageRequest, summarize: (row: unknown) => unknown): Row {
  const list = Array.isArray(rows) ? rows : [];
  const matching = page.status ? list.filter((row) => isRow(row) && row.status === page.status) : list;
  return {
    count: matching.length,
    [key]: matching.map(summarize),
    ...(list.length >= page.limit ? { nextOffset: page.offset + page.limit } : {}),
  };
}
