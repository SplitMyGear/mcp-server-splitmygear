/**
 * Timeout for the backend's AI generation routes (`/ai/*`, pricing
 * recommendations). The backend runs its paid models one after another inside
 * its own chain budget, so a first model that stalls makes a request outlast
 * the 15s default even though the second model answers; the tool would report
 * a failure while the backend finished the work. 25s still leaves room inside
 * the function's 30s `maxDuration` for authentication, which for an OAuth
 * token is local and costs no round-trip. These tools make one backend call.
 */
export const AI_GENERATION_TIMEOUT_MS = 25_000;
