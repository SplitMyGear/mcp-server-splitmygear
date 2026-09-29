/**
 * RFC 9728 Protected Resource Metadata. Served at the root well-known path and
 * at the path-aware variant for EITHER resource path MCP clients probe first
 * (`/.well-known/oauth-protected-resource/api/mcp` or `/mcp`) — both are
 * accepted here regardless of which one is canonical on this deployment,
 * because both `/api/mcp` and `/mcp` are always live endpoints (SPLIT-1621).
 * The returned document itself always names the CANONICAL resource
 * (`protectedResourceMetadata` → `mcpResourcePath()`), so a client that probed
 * the non-canonical suffix still gets pointed at the right one.
 */
import { protectedResourceMetadata } from '@/lib/oauth/metadata';
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
  return json(protectedResourceMetadata(publicBaseUrl(request)), 200, { 'Cache-Control': 'public, max-age=300' });
}

export async function OPTIONS() {
  return preflight();
}
