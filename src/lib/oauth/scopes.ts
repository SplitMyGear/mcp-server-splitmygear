/**
 * OAuth scopes for MCP connections.
 *
 * The scope taxonomy itself lives with the tool registry (`TOOL_SCOPES`): every
 * tool declares exactly one scope, and a connection may use a tool only when
 * that scope was granted at sign-in. This module owns the OAuth-facing side:
 * the human-readable descriptions shown on the consent page and in the docs,
 * and the RFC 6749 §3.3 `scope` parameter grammar (space-separated tokens).
 *
 * Defaults: a client that sends no `scope` (or an empty one) is asking for
 * FULL access, i.e. every scope; the consent page says so in plain words. The
 * user's backend role still applies on top of any scope set: granting the
 * `listings` scope to a renter account unlocks nothing.
 */
import { TOOL_SCOPES, type ToolScope } from '@/tools/registry';

export { TOOL_SCOPES };
export type { ToolScope };

/** One plain sentence per scope: what the connected app will be able to do. */
export const SCOPE_DESCRIPTIONS: Record<ToolScope, string> = {
  read: 'Search and read public listings, experiences, availability, prices and reviews.',
  profile: 'See and update your account profile, settings, notifications, trust score and personalised recommendations.',
  bookings: 'See, create, change and cancel bookings you are part of as renter or as the gear owner (rentals, experiences, services), pay through Stripe links, sign waivers and complete pickup and return checks.',
  favorites: 'See and manage your saved listings, searches and trips.',
  messaging: 'Read your conversations and send messages on your behalf.',
  reviews: 'Write, edit and delete your reviews and, for vendors, respond to reviews of your listings.',
  listings: 'Create and manage your listings, pricing, availability and vendor catalogue.',
  vendor_bookings: 'Vendor-only booking operations on your listings: incoming bookings, overdue and return status, reschedule proposals, private notes, auto-approve and booking risk.',
  experiences: 'Create and manage the experiences and schedules you host.',
  finance: 'See your payment and transaction history and, for vendors, earnings, payouts, promotions, tax and financial reports.',
  claims: 'File and manage claims, disputes and incidental charges.',
  files: 'Upload photos and documents for you.',
};

export type ParsedScopeParam =
  | { ok: true; scopes: ToolScope[]; requested: boolean }
  | { ok: false; error: string };

function isToolScope(value: string): value is ToolScope {
  return (TOOL_SCOPES as readonly string[]).includes(value);
}

/** Put scopes in the taxonomy's order and drop duplicates (a stable form for comparisons and tokens). */
function canonical(scopes: Iterable<ToolScope>): ToolScope[] {
  const set = new Set(scopes);
  return TOOL_SCOPES.filter((s) => set.has(s));
}

/**
 * Parse an RFC 6749 §3.3 `scope` parameter: space-separated, case-sensitive
 * tokens. Absent or blank means "everything" with `requested: false` so the
 * caller can tell the user the app asked for full access. Any unknown value
 * is an error (the OAuth `invalid_scope` case), never silently dropped.
 */
export function parseScopeParam(raw: string | undefined): ParsedScopeParam {
  const tokens = (raw ?? '').split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { ok: true, scopes: [...TOOL_SCOPES], requested: false };
  const unknown = tokens.filter((t) => !isToolScope(t));
  if (unknown.length) {
    return {
      ok: false,
      error: `Unknown scope${unknown.length > 1 ? 's' : ''} ${unknown.map((u) => JSON.stringify(u)).join(', ')}; supported scopes: ${TOOL_SCOPES.join(' ')}`,
    };
  }
  return { ok: true, scopes: canonical(tokens as ToolScope[]), requested: true };
}

/** Serialise scopes for the `scope` member of a token response (space-separated). */
export function formatScope(scopes: readonly ToolScope[]): string {
  return canonical(scopes).join(' ');
}

/** True when every scope in `a` is also in `b`. */
export function isSubset(a: readonly ToolScope[], b: readonly ToolScope[]): boolean {
  return a.every((s) => b.includes(s));
}

/**
 * Normalise a scope list read back from a sealed envelope. Unknown entries are
 * dropped (a scope retired from the taxonomy simply stops unlocking anything).
 * A missing list comes from an envelope sealed before scopes existed: those
 * grants were unrestricted at the time, so they keep every scope until they
 * expire (access tokens within minutes, refresh tokens within their TTL).
 */
export function coerceScopes(value: unknown): ToolScope[] {
  if (!Array.isArray(value)) return [...TOOL_SCOPES];
  return canonical(value.filter((v): v is ToolScope => typeof v === 'string' && isToolScope(v)));
}
