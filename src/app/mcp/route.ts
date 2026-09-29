/**
 * SPLIT-1621: the branded production endpoint, `POST /mcp`. Production sets
 * `MCP_RESOURCE_PATH=/mcp`, which makes this the CANONICAL path (the one
 * `resourceUrl()` names and the RFC 9728 metadata advertises); every other
 * deployment leaves it unset and keeps `/api/mcp` canonical instead. Either
 * way, BOTH paths are always served, on the exact same handler — this file
 * only re-exports the functions defined in `src/app/api/mcp/route.ts`, so
 * auth, rate limiting, CORS and the transport itself behave identically no
 * matter which literal path a request arrives on.
 *
 * Next.js route segment config (`dynamic`) must be a literal, statically
 * analyzable export IN THIS FILE — re-exporting it from another module is not
 * enough for the compiler to pick it up — so it is repeated here rather than
 * imported. `maxDuration` for this path is set the same way, in a matching
 * entry in vercel.json (Next's segment config only reads `dynamic` etc. from
 * the file itself; Vercel's function duration is configured per source path).
 */
import { NextRequest } from 'next/server';
import { DELETE as apiDelete, GET as apiGet, OPTIONS as apiOptions, POST as apiPost } from '@/app/api/mcp/route';

export const dynamic = 'force-dynamic';

export async function OPTIONS() {
  return apiOptions();
}

export async function POST(request: NextRequest) {
  return apiPost(request);
}

export async function GET() {
  return apiGet();
}

export async function DELETE() {
  return apiDelete();
}
