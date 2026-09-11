/** RFC 7009 token revocation (see lib/oauth/revoke.ts). */
import { handleRevokePost } from '@/lib/oauth/revoke';
import { preflight } from '@/lib/oauth/http';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return handleRevokePost(request);
}

export async function OPTIONS() {
  return preflight();
}
