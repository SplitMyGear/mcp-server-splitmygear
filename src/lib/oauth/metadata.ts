/**
 * Discovery documents.
 *  - RFC 9728 Protected Resource Metadata: tells an MCP client which
 *    authorization server protects `/api/mcp`.
 *  - RFC 8414 Authorization Server Metadata: where to register, authorize,
 *    exchange and revoke. Only PKCE-S256 public clients, code + refresh grants.
 */
import { MCP_RESOURCE_PATH } from './config';

export function protectedResourceMetadata(base: string) {
  return {
    resource: `${base}${MCP_RESOURCE_PATH}`,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
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
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    service_documentation: 'https://github.com/SplitMyGear/mcp-server-splitmygear#readme',
  };
}
