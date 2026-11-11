/**
 * Token revocation (RFC 7009). Either token of a connection may be presented,
 * and either one revokes the whole grant (SPLIT-1889):
 *
 * - The grant id is recorded as revoked for one access-token lifetime (see
 *   revocation.ts), so every access token the connection holds is rejected by
 *   the MCP auth middleware from now on, not when it expires.
 * - A refresh token is also revoked at the backend by rotating it (which
 *   invalidates the presented token) and then logging the rotated pair out,
 *   so the connection cannot be refreshed again.
 * - An access token cannot log the backend session out (that needs the
 *   refresh token), so the refresh grant refuses a revoked grant for as long
 *   as the record lives (token.ts). RFC 7009 §2.1 lets revoking an access token
 *   leave the refresh token alone; a client disconnecting for good revokes its
 *   refresh token.
 *
 * Unknown strings and tokens of another client answer 200, as the RFC requires.
 */
import { grantIdOf, openAccessToken, openRefreshToken, revocationTtlS } from './tokens';
import { revokeGrant } from './revocation';
import { backendRefresh, backendLogout, type ClientContext } from './backend-auth';
import { oauthEnabled } from './config';
import { oauthError, readParams, clientIp, json } from './http';

export async function handleRevokePost(request: Request): Promise<Response> {
  if (!oauthEnabled()) return oauthError('temporarily_unavailable', 'OAuth is not enabled on this server', 503);
  const p = await readParams(request);
  if (!p.token) return oauthError('invalid_request', 'token is required');
  // RFC 7009 §2.1: public clients must identify themselves.
  if (!p.client_id) return oauthError('invalid_request', 'client_id is required');
  const ctx: ClientContext = { ip: clientIp(request), userAgent: request.headers.get('user-agent') ?? undefined };

  const rt = openRefreshToken(p.token);
  if (rt && p.client_id === rt.cid) {
    await revokeGrant(grantIdOf(rt), revocationTtlS(rt.atl));
    try {
      const rotated = await backendRefresh(rt.brt, ctx);
      await backendLogout(rotated.accessToken, rotated.refreshToken, ctx);
    } catch {
      /* already invalid at the backend → nothing left to revoke */
    }
    return json({}, 200);
  }

  const at = rt ? null : openAccessToken(p.token);
  if (at && p.client_id === at.cid) {
    await revokeGrant(grantIdOf(at), revocationTtlS(at.exp - at.iat));
  }
  return json({}, 200);
}
