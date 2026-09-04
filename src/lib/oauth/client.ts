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
  // With an operator allow-list, only listed hosts may register (phishing
  // guard: anyone can otherwise register a lookalike "Claude" client that
  // sends the user to an attacker-controlled redirect).
  return allowedRedirectHosts().length === 0 || isAllowListedHost(url.hostname);
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
        error_description: allowedRedirectHosts().length
          ? 'redirect_uris must be http://localhost loopback URLs or https:// URLs on an allow-listed host'
          : 'redirect_uris must be https:// URLs or http://localhost loopback URLs',
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

/** Verify a client id's signature and decode its registration record. */
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
