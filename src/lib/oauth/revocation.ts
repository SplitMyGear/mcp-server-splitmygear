/**
 * Revoked OAuth grants (SPLIT-1889).
 *
 * Access tokens are stateless envelopes wrapping a stateless backend JWT, so
 * before this, revoking a connection (RFC 7009) logged its refresh token out
 * at the backend and left every access token it had issued working until it
 * expired, about 15 minutes. Revocation now also records the connection's
 * grant id (`sid`, see tokens.ts grantIdOf) here, and the auth middleware
 * rejects an access token whose grant is recorded.
 *
 * A record only has to outlive the access tokens issued before it, so it is
 * kept for one access-token lifetime (tokens.ts revocationTtlS) and then
 * expires on its own: nothing is stored per request or per token, only per
 * revoked connection.
 *
 * Layers, the same as the authorization-code replay cache (tokens.ts
 * markCodeRedeemed): the shared store when configured
 * (`mcp:revoked:<sid>`, cross-instance), and a per-instance map that is
 * always written and is consulted first, so the instance that served the
 * revocation never needs the store to honour it.
 *
 * FAILS OPEN when the store is unavailable, like every other check behind the
 * shared store (rate limit, sign-in throttle, code replay cache; see
 * lib/shared-store.ts): `isGrantRevoked` then answers from the per-instance
 * map alone, so on another instance a revoked access token keeps working until
 * it expires, which is exactly the pre-SPLIT-1889 behaviour and no worse. The
 * alternative, rejecting every OAuth call while the store is down, would take
 * the whole MCP offline on a defence-in-depth dependency. Without a store
 * configured at all the record is per instance only (the startup warning in
 * shared-store.ts covers it). The backend logout on refresh-token revocation
 * is unaffected either way, so a revoked connection can never be refreshed.
 *
 * Cost: at most one store read per MCP request, and only for a request
 * carrying an OAuth access envelope that already opened.
 */
import { getValue, putValue, sharedStoreEnabled } from '@/lib/shared-store';

const MAX_LOCAL = 10_000;

/** grant id -> unix ms after which the local record can be forgotten. */
const revokedLocally = new Map<string, number>();

function storeKey(grantId: string): string {
  return `mcp:revoked:${grantId}`;
}

function rememberLocally(grantId: string, ttlS: number, now: number): void {
  if (revokedLocally.size > MAX_LOCAL) {
    for (const [k, until] of revokedLocally) if (until <= now) revokedLocally.delete(k);
  }
  revokedLocally.set(grantId, now + ttlS * 1000);
}

function revokedHere(grantId: string, now: number): boolean {
  const until = revokedLocally.get(grantId);
  if (until === undefined) return false;
  if (until > now) return true;
  revokedLocally.delete(grantId);
  return false;
}

/** Record `grantId` as revoked for `ttlS` seconds, locally and in the shared store when there is one. */
export async function revokeGrant(grantId: string, ttlS: number): Promise<void> {
  rememberLocally(grantId, ttlS, Date.now());
  if (sharedStoreEnabled()) await putValue(storeKey(grantId), '1', ttlS);
}

/**
 * Has `grantId` been revoked? The local map first (no I/O), then ONE store
 * read. A store that is unavailable answers `null` and the local answer
 * stands (fail open, see the header).
 */
export async function isGrantRevoked(grantId: string): Promise<boolean> {
  if (revokedHere(grantId, Date.now())) return true;
  if (!sharedStoreEnabled()) return false;
  const value = await getValue(storeKey(grantId));
  return typeof value === 'string';
}

/** Test hook. */
export function _resetRevocationsForTests(): void {
  revokedLocally.clear();
}
