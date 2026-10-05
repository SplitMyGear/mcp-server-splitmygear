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
import { protectedResourceMetadata, wellKnownGet } from '@/lib/oauth/metadata';
import { preflight } from '@/lib/oauth/http';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  return wellKnownGet(request, context, protectedResourceMetadata);
}

export async function OPTIONS() {
  return preflight();
}
