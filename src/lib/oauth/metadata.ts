/**
 * Discovery documents.
 *  - RFC 9728 Protected Resource Metadata: tells an MCP client which
 *    authorization server protects `/api/mcp`.
 *  - RFC 8414 Authorization Server Metadata: where to register, authorize,
 *    exchange and revoke. Only PKCE-S256 public clients, code + refresh grants.
 *  Both list `scopes_supported` (RFC 8414 §2 / RFC 9728 §2) so clients can
 *  ask for a subset at sign-in; no `scope` means full access.
 */
import { MCP_RESOURCE_PATH } from './config';
import { TOOL_SCOPES } from './scopes';

export function protectedResourceMetadata(base: string) {
  return {
    resource: `${base}${MCP_RESOURCE_PATH}`,
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
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [...TOOL_SCOPES],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    service_documentation: 'https://github.com/SplitMyGear/mcp-server-splitmygear#readme',
  };
}
