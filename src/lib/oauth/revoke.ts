/**
 * Token revocation (RFC 7009). A refresh-token envelope is revoked at the
 * backend by rotating it (which invalidates the presented token) and then
 * logging the rotated pair out. An access-token envelope cannot be revoked
 * server-side (the backend JWT is stateless and short-lived) — we still answer
 * 200, as the RFC requires for unknown/unsupported tokens.
 */
import { openRefreshToken, openAccessToken } from './tokens';
import { backendRefresh, backendLogout, type ClientContext } from './backend-auth';
import { oauthEnabled } from './config';
import { oauthError, readParams, clientIp, json } from './http';

export async function handleRevokePost(request: Request): Promise<Response> {
  if (!oauthEnabled()) return oauthError('temporarily_unavailable', 'OAuth is not enabled on this server', 503);
  const p = await readParams(request);
  if (!p.token) return oauthError('invalid_request', 'token is required');
  const ctx: ClientContext = { ip: clientIp(request), userAgent: request.headers.get('user-agent') ?? undefined };

  const rt = openRefreshToken(p.token);
  if (rt) {
    if (p.client_id !== undefined && p.client_id !== rt.cid) return json({}, 200);
    try {
      const rotated = await backendRefresh(rt.brt, ctx);
      await backendLogout(rotated.accessToken, rotated.refreshToken, ctx);
    } catch {
      /* already invalid at the backend → nothing left to revoke */
    }
    return json({}, 200);
  }
  const at = openAccessToken(p.token);
  if (at) {
    if (p.client_id === undefined || p.client_id === at.cid) await backendLogout(at.bt, '', ctx);
  }
  return json({}, 200);
}
