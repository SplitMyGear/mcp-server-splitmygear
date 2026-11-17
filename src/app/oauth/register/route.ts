/** RFC 7591 dynamic client registration (public clients, stateless signed ids). */
import { registerClient } from '@/lib/oauth/client';
import { oauthEnabled } from '@/lib/oauth/config';
import { claimPublicBudget } from '@/lib/oauth/throttle';
import { exceedsContentLength, json, oauthError, preflight } from '@/lib/oauth/http';

export const dynamic = 'force-dynamic';
const MAX_BODY_BYTES = 8 * 1024;

export async function POST(request: Request) {
  if (!oauthEnabled()) return oauthError('temporarily_unavailable', 'OAuth is not enabled on this server', 503);
  // SPLIT-1921: registration is unauthenticated and mints a signed client id per
  // call, so it is budgeted per client IP (20 per hour; a real client registers
  // once per install).
  if (!(await claimPublicBudget('register', request))) {
    return oauthError('temporarily_unavailable', 'Too many registrations from this address. Try again later.', 429, { 'Retry-After': '3600' });
  }
  if (exceedsContentLength(request, MAX_BODY_BYTES)) return oauthError('invalid_client_metadata', 'Registration body too large');
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return oauthError('invalid_client_metadata', 'Registration body too large');
  let metadata: unknown;
  try {
    metadata = JSON.parse(text);
  } catch {
    return oauthError('invalid_client_metadata', 'Body must be a JSON object');
  }
  const result = registerClient(metadata);
  if ('error' in result) return json(result, 400);
  return json(
    {
      client_id: result.client_id,
      client_id_issued_at: result.client_id_issued_at,
      // RFC 7591 §3.2.1: 0 = never expires. Deliberate — see resolveClient for
      // why a TTL buys nothing here and what replaces it.
      client_id_expires_at: 0,
      client_name: result.client_name,
      redirect_uris: result.redirect_uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
    201,
  );
}

export async function OPTIONS() {
  return preflight();
}
