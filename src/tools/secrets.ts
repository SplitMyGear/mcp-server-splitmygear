/**
 * Backend fields that are bearer secrets wherever they appear, and what a tool
 * result shows instead.
 *
 * Every tool result passes through `scrubSecrets` (registry `ok` / `fail`), so no
 * tool, today's or a future one, carries these into an LLM transcript, where
 * results are stored, synced and shared. The backend rightly gives an owner their
 * own listing's iCal URL, and that listing rides along in many answers: the
 * listing itself, the list of listings, rate rules, fleet units and their
 * maintenance log, pricing answers. Patching tools one by one had already missed
 * three of them.
 */

/** Shown instead of a listing's iCal URL: anyone holding it can read the calendar. */
export const ICAL_URL_REDACTED = '[redacted: manage calendar feeds in the Splitt dashboard]';

/** Shown instead of a listing's calendar key: it unlocks the feed that names renters. */
export const ICAL_KEY_REDACTED = "[redacted: the listing's private calendar key]";

const SECRET_FIELDS: ReadonlyMap<string, string> = new Map([
  ['icalUrl', ICAL_URL_REDACTED],
  ['icalFeedToken', ICAL_KEY_REDACTED],
]);

/**
 * Fields that never reach a tool result, at any depth (SPLIT-1608):
 * - `embedding`, a listing's search vector (about 15 KB of numbers), which the
 *   backend returns with a saved listing;
 * - from a user row the backend embeds with a service or a waiver (its host),
 *   the IP address and browser of the user's terms acceptance and Splitt's
 *   internal settings on the account (commission override, moderation bypass,
 *   suspension note). The user's own profile shows none of them.
 */
const DROPPED_FIELDS: ReadonlySet<string> = new Set([
  'embedding',
  'termsAcceptedIp',
  'termsAcceptedUserAgent',
  'customCommissionRate',
  'moderationBypassEnabled',
  'suspensionReason',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0);
}

/**
 * A copy of `value` with every secret field, at any depth, replaced by its note
 * (or left out when it holds nothing), and every dropped field left out. Only plain objects and arrays are walked,
 * so Dates and other instances reach the serializer unchanged. A JSON key named
 * `__proto__` is dropped: it is never data, and assigning it would re-parent the copy.
 */
export function scrubSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (key === '__proto__' || DROPPED_FIELDS.has(key)) continue;
    const note = SECRET_FIELDS.get(key);
    if (note === undefined) out[key] = scrubSecrets(field);
    else if (hasValue(field)) out[key] = note;
  }
  return out;
}
