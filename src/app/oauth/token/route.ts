/** OAuth 2.1 token endpoint (see lib/oauth/token.ts). */
import { handleTokenPost } from '@/lib/oauth/token';
import { preflight } from '@/lib/oauth/http';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return handleTokenPost(request);
}

export async function OPTIONS() {
  return preflight();
}
