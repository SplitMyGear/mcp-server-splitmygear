/** OAuth 2.1 authorization endpoint — hosted Splitt sign-in (see lib/oauth/authorize.ts). */
import { handleAuthorizeGet, handleAuthorizePost } from '@/lib/oauth/authorize';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return handleAuthorizeGet(request);
}

export async function POST(request: Request) {
  return handleAuthorizePost(request);
}
