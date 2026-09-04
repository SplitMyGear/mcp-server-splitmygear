/** RFC 7591 dynamic client registration (public clients, stateless signed ids). */
import { registerClient } from '@/lib/oauth/client';
import { oauthEnabled } from '@/lib/oauth/config';
import { json, oauthError, preflight } from '@/lib/oauth/http';

export const dynamic = 'force-dynamic';
const MAX_BODY_BYTES = 8 * 1024;

export async function POST(request: Request) {
  if (!oauthEnabled()) return oauthError('temporarily_unavailable', 'OAuth is not enabled on this server', 503);
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
