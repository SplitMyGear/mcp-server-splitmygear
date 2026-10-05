/**
 * Discovery documents.
 *  - RFC 9728 Protected Resource Metadata: tells an MCP client which
 *    authorization server protects the MCP endpoint (`resource`, always the
 *    CANONICAL path — see `mcpResourcePath()`, SPLIT-1621 — even though the
 *    non-canonical path also answers).
 *  - RFC 8414 Authorization Server Metadata: where to register, authorize,
 *    exchange and revoke. Only PKCE-S256 public clients, code + refresh grants.
 *  Both list `scopes_supported` (RFC 8414 §2 / RFC 9728 §2) so clients can
 *  ask for a subset at sign-in; no `scope` means full access.
 */
import { mcpResourcePath, oauthEnabled, publicBaseUrl, MCP_RESOURCE_PATHS } from './config';
import { json } from './http';
import { TOOL_SCOPES } from './scopes';

export function protectedResourceMetadata(base: string) {
  return {
    resource: `${base}${mcpResourcePath()}`,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: [...TOOL_SCOPES],
    resource_name: 'Splitt MCP',
    resource_documentation: 'https://github.com/SplitMyGear/mcp-server-splitmygear#readme',
  };
}

export function authorizationServerMetadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    // RFC 9207: every redirect from /oauth/authorize, success or error, carries
    // `iss` = this issuer, which lets a client that talks to several
    // authorization servers detect a mix-up attack. ChatGPT also uses its
    // stable redirect URI only for servers that make this promise.
    authorization_response_iss_parameter_supported: true,
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [...TOOL_SCOPES],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    service_documentation: 'https://github.com/SplitMyGear/mcp-server-splitmygear#readme',
  };
}

/** `MCP_RESOURCE_PATHS` without their leading slash, as a well-known suffix appears. */
const KNOWN_SUFFIXES = MCP_RESOURCE_PATHS.map((p) => p.slice(1));

/**
 * Shared GET for the two `.well-known` routes: 404 when OAuth is off or the
 * path-aware suffix is not one of ours, else the document `build` makes.
 */
export async function wellKnownGet(
  request: Request,
  context: { params: Promise<{ path?: string[] }> },
  build: (base: string) => object,
): Promise<Response> {
  if (!oauthEnabled()) return json({ error: 'not_found', error_description: 'OAuth is not enabled on this server' }, 404);
  // RFC 8414 / 9728 path-aware discovery: only the root document and the ones
  // for our two live resource paths exist; any other suffix is not ours to answer.
  const suffix = ((await context.params).path ?? []).join('/');
  if (suffix !== '' && !KNOWN_SUFFIXES.includes(suffix)) return json({ error: 'not_found' }, 404);
  return json(build(publicBaseUrl(request)), 200, { 'Cache-Control': 'public, max-age=300' });
}
