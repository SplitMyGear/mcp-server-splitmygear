/**
 * Token revocation (RFC 7009). Either token of a connection may be presented,
 * and either one revokes the whole grant (SPLIT-1889):
 *
 * - The grant id is recorded as revoked (see revocation.ts), so every access
 *   token the connection holds is rejected by the MCP auth middleware from now
 *   on, not when it expires. Revoking a refresh token keeps the record for the
 *   refresh token's remaining life, an access token for one access lifetime.
 * - A refresh token is also revoked at the backend by rotating it (which
 *   invalidates the presented token) and then logging the rotated pair out,
 *   so the connection cannot be refreshed again. Only a definite "that token is
 *   not valid" from the backend counts as done; a timeout or 5xx answers 503
 *   so the client retries (SPLIT-1921).
 * - An access token cannot log the backend session out (that needs the
 *   refresh token), so the refresh grant refuses a revoked grant for as long
 *   as the record lives (token.ts). RFC 7009 §2.1 lets revoking an access token
 *   leave the refresh token alone; a client disconnecting for good revokes its
 *   refresh token.
 *
 * Unknown strings and tokens of another client answer 200, as the RFC requires.
 */
import { grantIdOf, openAccessToken, openRefreshToken, refreshRevocationTtlS, revocationTtlS } from './tokens';
import { revokeGrant } from './revocation';
import { AuthBridgeError, backendRefresh, backendLogout, type ClientContext } from './backend-auth';
import { oauthEnabled } from './config';
import { oauthError, readParams, clientIp, json } from './http';

function isDefinitelyInvalid(error: unknown): boolean {
  return error instanceof AuthBridgeError && (error.status === 400 || error.status === 401 || error.status === 403);
}

/** RFC 7009 §2.2.1: the server could not complete the revocation; the client should retry. */
function retryLater(): Response {
  return oauthError('temporarily_unavailable', 'Revocation could not be completed right now. Please retry.', 503, { 'Retry-After': '5' });
}

export async function handleRevokePost(request: Request): Promise<Response> {
  if (!oauthEnabled()) return oauthError('temporarily_unavailable', 'OAuth is not enabled on this server', 503);
  const p = await readParams(request);
  if (!p.token) return oauthError('invalid_request', 'token is required');
  // RFC 7009 §2.1: public clients must identify themselves.
  if (!p.client_id) return oauthError('invalid_request', 'client_id is required');
  const ctx: ClientContext = { ip: clientIp(request), userAgent: request.headers.get('user-agent') ?? undefined };

  const rt = openRefreshToken(p.token);
  if (rt && p.client_id === rt.cid) {
    // SPLIT-1921: recorded before anything can fail, and for as long as the
    // refresh token could still be redeemed (the backend token stays valid up
    // to 30 days if the logout below does not land).
    await revokeGrant(grantIdOf(rt), refreshRevocationTtlS(rt));

    let rotated;
    try {
      rotated = await backendRefresh(rt.brt, ctx);
    } catch (error) {
      // Only a definite "this token is not valid" means there is nothing left
      // to revoke. A timeout, network error, 5xx or 429 says nothing about the
      // token, so telling the client 200 would leave it live: ask for a retry.
      if (isDefinitelyInvalid(error)) return json({}, 200);
      return retryLater();
    }

    // The refresh ROTATED the backend token: the presented one is dead and the
    // new one exists only here, so a failed logout cannot be recovered by the
    // client's retry (it will see "already invalid"). Try once more, then ask
    // for a retry anyway: the backend honours a just-rotated token for a short
    // grace window, so a prompt retry rotates again and logs out the family.
    if (!(await backendLogout(rotated.accessToken, rotated.refreshToken, ctx)) && !(await backendLogout(rotated.accessToken, rotated.refreshToken, ctx))) {
      return retryLater();
    }
    return json({}, 200);
  }

  // Access-token-only revoke: one access lifetime is intentional (the refresh
  // token is left alone, RFC 7009 §2.1), and the record is never shortened.
  const at = rt ? null : openAccessToken(p.token);
  if (at && p.client_id === at.cid) {
    await revokeGrant(grantIdOf(at), revocationTtlS(at.exp - at.iat));
  }
  return json({}, 200);
}
