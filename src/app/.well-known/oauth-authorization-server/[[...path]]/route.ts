/** RFC 8414 Authorization Server Metadata (root + path-aware variants). */
import { authorizationServerMetadata } from '@/lib/oauth/metadata';
import { oauthEnabled, publicBaseUrl } from '@/lib/oauth/config';
import { json, preflight } from '@/lib/oauth/http';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  if (!oauthEnabled()) return json({ error: 'not_found', error_description: 'OAuth is not enabled on this server' }, 404);
  // RFC 8414 / 9728 path-aware discovery: only the root document and the one
  // for our resource path exist; any other suffix is not ours to answer.
  const suffix = ((await context.params).path ?? []).join('/');
  if (suffix !== '' && suffix !== 'api/mcp') return json({ error: 'not_found' }, 404);
  return json(authorizationServerMetadata(publicBaseUrl(request)), 200, { 'Cache-Control': 'public, max-age=300' });
}

export async function OPTIONS() {
  return preflight();
}
