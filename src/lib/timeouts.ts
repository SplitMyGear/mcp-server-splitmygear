/**
 * Timeout for the backend's AI generation routes (`/ai/*`, pricing
 * recommendations). The backend runs its paid models one after another inside
 * its own chain budget, so a first model that stalls makes a request outlast
 * the 15s default even though the second model answers; the tool would report
 * a failure while the backend finished the work. 25s leaves ample room inside
 * the /api/mcp function's 60s `maxDuration` (vercel.json) for authentication,
 * which for an OAuth token is local and costs no round-trip. These tools make
 * one backend call.
 */
export const AI_GENERATION_TIMEOUT_MS = 25_000;

/**
 * Timeout for listing writes (create, update, duplicate). The backend enriches
 * a listing with AI before it answers (a care guide and a search embedding), and
 * on 2026-09-28 a create took about 23 s: the 15 s default reported a failure
 * while the listing was still being committed, and the obvious retry would have
 * created it twice (SPLIT-1608). 45 s fits the /api/mcp function's 60 s
 * `maxDuration` together with the identity check that runs first.
 */
export const LISTING_WRITE_TIMEOUT_MS = 45_000;
