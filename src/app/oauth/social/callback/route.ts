/**
 * Return leg of "Continue with Google / Apple": the Splitt backend redirects
 * the browser here with a one-time exchange code (or an error). The code is
 * swapped for a session and the sign-in finishes exactly like the password
 * path (see lib/oauth/authorize.ts).
 */
import { handleSocialCallbackGet } from '@/lib/oauth/authorize';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return handleSocialCallbackGet(request);
}
