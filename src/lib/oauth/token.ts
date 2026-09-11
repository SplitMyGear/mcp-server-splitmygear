/**
 * Token endpoint logic (RFC 6749 §4.1.3 / §6, OAuth 2.1): `authorization_code`
 * with mandatory PKCE, and `refresh_token` proxied to the backend's rotation.
 * Public clients only; `client_id` travels in the body. Every response carries
 * `scope`; a refresh may pass `scope` to NARROW the grant (RFC 6749 §6), never
 * to widen it.
 */
import { verifyS256 } from './pkce';
import { openAuthorizationCode, markCodeRedeemed, issueTokens, openRefreshToken } from './tokens';
import { oauthEnabled, resourceUrl } from './config';
import { formatScope, isSubset, parseScopeParam, type ToolScope } from './scopes';
import { backendRefresh, AuthBridgeError, type ClientContext } from './backend-auth';
import { json, oauthError, readParams, clientIp } from './http';

export async function handleTokenPost(request: Request): Promise<Response> {
  if (!oauthEnabled()) return oauthError('temporarily_unavailable', 'OAuth is not enabled on this server', 503);
  const p = await readParams(request);
  const ctx: ClientContext = { ip: clientIp(request), userAgent: request.headers.get('user-agent') ?? undefined };

  switch (p.grant_type) {
    case 'authorization_code':
      return authorizationCodeGrant(p, request);
    case 'refresh_token':
      return refreshTokenGrant(p, ctx);
    case undefined:
      return oauthError('invalid_request', 'grant_type is required');
    default:
      return oauthError('unsupported_grant_type', `grant_type "${p.grant_type}" is not supported`);
  }
}

async function authorizationCodeGrant(p: Record<string, string>, request: Request): Promise<Response> {
  if (!p.code) return oauthError('invalid_request', 'code is required');
  if (!p.code_verifier) return oauthError('invalid_request', 'code_verifier is required (PKCE)');
  if (!p.redirect_uri) return oauthError('invalid_request', 'redirect_uri is required');
  if (!p.client_id) return oauthError('invalid_request', 'client_id is required');

  const code = openAuthorizationCode(p.code);
  if (!code) return oauthError('invalid_grant', 'Authorization code is invalid or expired');
  if (code.cid !== p.client_id) return oauthError('invalid_grant', 'Authorization code was issued to a different client');
  if (code.ru !== p.redirect_uri) return oauthError('invalid_grant', 'redirect_uri does not match the authorization request');
  if (!verifyS256(p.code_verifier, code.cc)) return oauthError('invalid_grant', 'PKCE verification failed');
  if (p.resource !== undefined && p.resource !== (code.res ?? resourceUrl(request))) {
    return oauthError('invalid_target', 'resource does not match the authorization request');
  }
  if (!(await markCodeRedeemed(code.jti, code.exp))) return oauthError('invalid_grant', 'Authorization code has already been used');

  const tokens = issueTokens({
    clientId: code.cid,
    user: { id: code.sub, role: code.role, email: code.email },
    backendAccessToken: code.at,
    backendRefreshToken: code.rt,
    scopes: code.sc,
  });
  if (!tokens) return oauthError('server_error', 'Could not issue tokens for this session', 500);
  return json(tokens);
}

/**
 * RFC 6749 §6: an optional `scope` on refresh must not include anything the
 * user did not originally grant; omitted means "same as before".
 */
function narrowedScopes(requested: string | undefined, granted: ToolScope[]): ToolScope[] | Response {
  const parsed = parseScopeParam(requested);
  if (!parsed.ok) return oauthError('invalid_scope', parsed.error);
  if (!parsed.requested) return granted;
  if (!isSubset(parsed.scopes, granted)) {
    return oauthError('invalid_scope', `scope may only narrow the original grant (${formatScope(granted) || 'none'})`);
  }
  return parsed.scopes;
}

async function refreshTokenGrant(p: Record<string, string>, ctx: ClientContext): Promise<Response> {
  if (!p.refresh_token) return oauthError('invalid_request', 'refresh_token is required');
  // OAuth 2.1 §4.3.1: public clients identify themselves on every token request.
  if (!p.client_id) return oauthError('invalid_request', 'client_id is required');
  const rt = openRefreshToken(p.refresh_token);
  if (!rt) return oauthError('invalid_grant', 'Refresh token is invalid or expired');
  if (p.client_id !== rt.cid) return oauthError('invalid_grant', 'Refresh token was issued to a different client');
  const scopes = narrowedScopes(p.scope, rt.scp);
  if (scopes instanceof Response) return scopes;
  try {
    const rotated = await backendRefresh(rt.brt, ctx);
    const tokens = issueTokens({
      clientId: rt.cid,
      user: { id: rt.sub, role: rt.role, email: rt.email },
      backendAccessToken: rotated.accessToken,
      backendRefreshToken: rotated.refreshToken,
      scopes,
    });
    if (!tokens) return oauthError('server_error', 'Could not issue tokens for this session', 500);
    return json(tokens);
  } catch (error) {
    // 400 (rejected DTO / rotated token), 401 (revoked or expired), 403
    // (suspended): the grant is dead either way, so tell the client to
    // re-authenticate instead of retrying against a "temporary" failure.
    if (error instanceof AuthBridgeError && (error.status === 400 || error.status === 401 || error.status === 403)) {
      return oauthError('invalid_grant', 'Refresh token has been revoked or expired; sign in again');
    }
    return oauthError('temporarily_unavailable', 'Splitt is temporarily unavailable; try again shortly', 503);
  }
}
