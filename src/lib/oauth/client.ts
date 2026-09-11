/**
 * Stateless dynamic client registration (RFC 7591).
 *
 * A registered client is a `client_id` that IS its own signed record:
 *
 *   smg_c.<base64url(json)>.<base64url(hmac-sha256)>
 *
 * The JSON carries the redirect URIs and display name the client registered
 * with; the HMAC (purpose-bound key) proves this server issued it and that the
 * redirect URIs have not been altered. No database, no cross-instance sync.
 *
 * Only PUBLIC clients are supported (`token_endpoint_auth_method: "none"`,
 * PKCE mandatory) — the MCP clients that connect (Claude, Cursor, Windsurf,
 * custom agents) cannot keep a secret. Redirect URIs must be `https://`, or
 * loopback `http://localhost` / `http://127.0.0.1` / `http://[::1]` for
 * desktop apps that run a local callback listener (RFC 8252 §7.3).
 */
import crypto from 'crypto';
import { allowedRedirectHosts, deriveKey, isAllowListedHost, isLoopbackHost } from './config';

export const CLIENT_ID_PREFIX = 'smg_c';
const MAX_REDIRECT_URIS = 10;
const MAX_NAME_LENGTH = 100;

export interface RegisteredClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  /** Unix seconds at registration. */
  client_id_issued_at: number;
}

interface ClientRecord {
  n?: string;
  ru: string[];
  iat: number;
  /** Random nonce so two registrations with identical metadata still get distinct ids. */
  id: string;
}

export type RegistrationError = { error: 'invalid_redirect_uri' | 'invalid_client_metadata'; error_description: string };

/**
 * May this redirect URI be registered, under the CURRENT operator policy?
 *
 * Loopback is always allowed (RFC 8252 §7.3: it never leaves the user's
 * machine). Every other https host must be on the operator's allow-list, and
 * an empty allow-list therefore permits nothing (SPLIT-1420) — the phishing
 * guard has to fail closed, because anyone may call `/oauth/register` and a
 * lookalike "Claude" client pointing at an attacker's redirect turns
 * `/oauth/authorize` on the real MCP origin into a credential-harvesting page.
 */
export function isAllowedRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === 'http:') return isLoopbackHost(url.hostname);
  if (url.protocol !== 'https:') return false;
  return isAllowListedHost(url.hostname);
}

/** A redirect URI is "verified" when it is loopback or on the operator allow-list. */
export function isVerifiedRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return isLoopbackHost(url.hostname) || isAllowListedHost(url.hostname);
  } catch {
    return false;
  }
}

/** Validate RFC 7591 client metadata and mint a signed client id. */
export function registerClient(metadata: unknown): RegisteredClient | RegistrationError {
  if (!metadata || typeof metadata !== 'object') {
    return { error: 'invalid_client_metadata', error_description: 'Client metadata must be a JSON object' };
  }
  const m = metadata as Record<string, unknown>;
  const redirectUris = m.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS) {
    return { error: 'invalid_redirect_uri', error_description: `redirect_uris must list 1–${MAX_REDIRECT_URIS} URIs` };
  }
  for (const uri of redirectUris) {
    if (typeof uri !== 'string' || !isAllowedRedirectUri(uri)) {
      return {
        error: 'invalid_redirect_uri',
        // Name the environment variable: an empty allow-list now rejects every
        // https host, and an operator staring at a registration failure needs
        // to know it is policy, not a malformed URI.
        error_description: allowedRedirectHosts().length
          ? 'redirect_uris must be http://localhost loopback URLs or https:// URLs on a host allow-listed in MCP_OAUTH_ALLOWED_REDIRECT_HOSTS'
          : 'No redirect hosts are allow-listed on this server, so only http://localhost loopback URLs may register. The operator must set MCP_OAUTH_ALLOWED_REDIRECT_HOSTS.',
      };
    }
  }
  if (m.token_endpoint_auth_method !== undefined && m.token_endpoint_auth_method !== 'none') {
    return { error: 'invalid_client_metadata', error_description: 'Only public clients (token_endpoint_auth_method "none") are supported' };
  }
  if (m.grant_types !== undefined) {
    const grants = Array.isArray(m.grant_types) ? m.grant_types : [];
    const unsupported = grants.filter((g) => g !== 'authorization_code' && g !== 'refresh_token');
    if (grants.length === 0 || unsupported.length > 0) {
      return { error: 'invalid_client_metadata', error_description: 'grant_types may only contain authorization_code and refresh_token' };
    }
  }
  if (m.response_types !== undefined) {
    const types = Array.isArray(m.response_types) ? m.response_types : [];
    if (types.length === 0 || types.some((t) => t !== 'code')) {
      return { error: 'invalid_client_metadata', error_description: 'response_types may only contain "code"' };
    }
  }
  const name = typeof m.client_name === 'string' ? m.client_name.trim().slice(0, MAX_NAME_LENGTH) : undefined;

  const record: ClientRecord = {
    ru: redirectUris as string[],
    iat: Math.floor(Date.now() / 1000),
    id: crypto.randomBytes(9).toString('base64url'),
  };
  if (name) record.n = name;
  const body = Buffer.from(JSON.stringify(record)).toString('base64url');
  const sig = sign(body);
  return {
    client_id: `${CLIENT_ID_PREFIX}.${body}.${sig}`,
    client_name: name,
    redirect_uris: record.ru,
    client_id_issued_at: record.iat,
  };
}

/**
 * Verify a client id's signature and decode its registration record.
 *
 * WHY THERE IS NO EXPIRY (SPLIT-1420, and `client_id_expires_at: 0` in the
 * registration response per RFC 7591 §3.2.1). A client id here is a public
 * identifier, not a credential: it carries no authority, grants nothing on its
 * own, and every id this server ever issued is invalidated wholesale the
 * moment `MCP_OAUTH_SIGNING_KEY` is rotated. A fixed TTL would buy no security
 * and would silently break long-lived connections whose MCP client does not
 * re-run dynamic registration.
 *
 * What an expiry WOULD have bought — that a client registered under an old,
 * looser policy cannot keep using it forever — is bought directly instead: the
 * redirect URIs are re-checked against the CURRENT allow-list on every
 * resolution, not just at registration. So tightening (or first setting)
 * `MCP_OAUTH_ALLOWED_REDIRECT_HOSTS` takes effect immediately for ids already
 * out in the wild, and an id minted while the list was empty stops working the
 * moment the operator narrows it. That is the revocation lever; time is not.
 */
export function resolveClient(clientId: unknown): RegisteredClient | null {
  if (typeof clientId !== 'string') return null;
  const parts = clientId.split('.');
  if (parts.length !== 3 || parts[0] !== CLIENT_ID_PREFIX) return null;
  const [, body, sig] = parts;
  const expected = Buffer.from(sign(body));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  let record: ClientRecord;
  try {
    record = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!record || !Array.isArray(record.ru) || record.ru.some((u) => typeof u !== 'string')) return null;
  // Current policy, not the policy at registration time.
  if (!record.ru.every((u) => isAllowedRedirectUri(u))) return null;
  return {
    client_id: clientId,
    client_name: record.n,
    redirect_uris: record.ru,
    client_id_issued_at: record.iat,
  };
}

/** Exact-match check of a redirect_uri against the registered list (RFC 6749 §3.1.2.3). */
export function clientAllowsRedirect(client: RegisteredClient, redirectUri: string): boolean {
  return client.redirect_uris.includes(redirectUri);
}

function sign(body: string): string {
  return crypto.createHmac('sha256', deriveKey('client')).update(body).digest('base64url');
}
