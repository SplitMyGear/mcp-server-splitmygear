/**
 * Start leg of "Continue with Google / Apple" on the hosted sign-in page: sends
 * the browser to the Splitt backend's provider flow with a return_to that
 * points back at /oauth/social/callback (see lib/oauth/authorize.ts).
 */
import { handleSocialStartGet } from '@/lib/oauth/authorize';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return handleSocialStartGet(request);
}
