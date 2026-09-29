/**
 * RFC 8414 Authorization Server Metadata (root + path-aware variants). The
 * issuer has no path, so a compliant client fetches the root document; some
 * older MCP clients probe the path-aware form using the RESOURCE path instead.
 * Both resource paths (`/mcp`, `/api/mcp`) are always live, and which one is
 * canonical is per deployment (SPLIT-1621; production's is `/mcp`), so either
 * suffix is answered with the same document, matching the protected-resource
 * metadata route.
 */
import { authorizationServerMetadata } from '@/lib/oauth/metadata';
import { oauthEnabled, publicBaseUrl, MCP_RESOURCE_PATHS } from '@/lib/oauth/config';
import { json, preflight } from '@/lib/oauth/http';

export const dynamic = 'force-dynamic';

/** `MCP_RESOURCE_PATHS` without their leading slash, as a well-known suffix appears. */
const KNOWN_SUFFIXES = MCP_RESOURCE_PATHS.map((p) => p.slice(1));

export async function GET(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  if (!oauthEnabled()) return json({ error: 'not_found', error_description: 'OAuth is not enabled on this server' }, 404);
  // RFC 8414 / 9728 path-aware discovery: only the root document and the ones
  // for our two live resource paths exist; any other suffix is not ours to answer.
  const suffix = ((await context.params).path ?? []).join('/');
  if (suffix !== '' && !KNOWN_SUFFIXES.includes(suffix)) return json({ error: 'not_found' }, 404);
  return json(authorizationServerMetadata(publicBaseUrl(request)), 200, { 'Cache-Control': 'public, max-age=300' });
}

export async function OPTIONS() {
  return preflight();
}
