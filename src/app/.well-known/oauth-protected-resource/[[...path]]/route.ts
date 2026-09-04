/**
 * RFC 9728 Protected Resource Metadata. Served at both the root well-known
 * path and the path-aware variant (`/.well-known/oauth-protected-resource/api/mcp`)
 * that MCP clients probe first.
 */
import { protectedResourceMetadata } from '@/lib/oauth/metadata';
import { oauthEnabled, publicBaseUrl } from '@/lib/oauth/config';
import { json, preflight } from '@/lib/oauth/http';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!oauthEnabled()) return json({ error: 'not_found', error_description: 'OAuth is not enabled on this server' }, 404);
  return json(protectedResourceMetadata(publicBaseUrl(request)), 200, { 'Cache-Control': 'public, max-age=300' });
}

export async function OPTIONS() {
  return preflight();
}
