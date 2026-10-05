/**
 * RFC 8414 Authorization Server Metadata (root + path-aware variants). The
 * issuer has no path, so a compliant client fetches the root document; some
 * older MCP clients probe the path-aware form using the RESOURCE path instead.
 * Both resource paths (`/mcp`, `/api/mcp`) are always live, and which one is
 * canonical is per deployment (SPLIT-1621; production's is `/mcp`), so either
 * suffix is answered with the same document, matching the protected-resource
 * metadata route.
 */
import { authorizationServerMetadata, wellKnownGet } from '@/lib/oauth/metadata';
import { preflight } from '@/lib/oauth/http';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  return wellKnownGet(request, context, authorizationServerMetadata);
}

export async function OPTIONS() {
  return preflight();
}
