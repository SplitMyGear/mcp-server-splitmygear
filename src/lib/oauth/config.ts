/**
 * OAuth 2.1 configuration for the MCP server (MCP authorization spec, RFC 9728
 * protected-resource metadata, RFC 8414 AS metadata, RFC 7591 DCR).
 *
 * The MCP server is BOTH the OAuth resource server (the `/api/mcp` endpoint)
 * and a thin, STATELESS authorization server that fronts the Splitt backend's
 * own login (`POST /users/login`, email-OTP 2FA, `POST /auth/refresh`). It
 * never stores sessions: every artifact it hands out (authorization code,
 * access token, refresh token, registered client id, in-flight login request)
 * is an AES-256-GCM envelope sealed with `MCP_OAUTH_SIGNING_KEY`, so any
 * serverless instance can validate what any other instance issued.
 *
 * OAuth is OPT-IN: without `MCP_OAUTH_SIGNING_KEY` every OAuth endpoint fails
 * closed (404/503) and the server keeps working with the operator API key and
 * raw backend JWT bearer paths exactly as before.
 */
import crypto from 'crypto';

/** Minimum entropy we insist on for the sealing secret (bytes of the raw string). */
const MIN_SECRET_LENGTH = 32;

/** Path of the protected MCP resource, relative to the public base URL. */
export const MCP_RESOURCE_PATH = '/api/mcp';

export function oauthSigningSecret(): string | undefined {
  const secret = process.env.MCP_OAUTH_SIGNING_KEY;
  if (!secret || secret.length < MIN_SECRET_LENGTH) return undefined;
  return secret;
}

/** True when the OAuth layer is configured and may issue/validate artifacts. */
export function oauthEnabled(): boolean {
  return oauthSigningSecret() !== undefined;
}

/**
 * Derive a purpose-bound 32-byte key from the operator secret. Each purpose
 * (`token`, `client`, `request`) gets its own key so an artifact sealed for one
 * purpose can never be replayed as another (a code is not an access token).
 */
export function deriveKey(purpose: string): Buffer {
  const secret = oauthSigningSecret();
  if (!secret) throw new Error('OAuth is not configured (MCP_OAUTH_SIGNING_KEY)');
  return crypto.createHash('sha256').update(`splitt-mcp:${purpose}:`).update(secret).digest();
}

/**
 * The public base URL of THIS server (issuer + resource origin). Resolution
 * order: explicit `MCP_PUBLIC_URL` → Vercel's production URL system env →
 * the incoming request's origin (local dev only). The issuer must be a stable,
 * operator-controlled value in production: a client discovering metadata is
 * told where to send the user and the tokens, so it must never be derived
 * from an attacker-influenced Host header there.
 */
export function publicBaseUrl(request?: Request): string {
  const explicit = process.env.MCP_PUBLIC_URL;
  if (explicit) return stripTrailingSlash(explicit);
  const vercelProd = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercelProd) return `https://${stripTrailingSlash(vercelProd)}`;
  if (request) {
    try {
      return new URL(request.url).origin;
    } catch {
      /* fall through */
    }
  }
  return 'http://localhost:3000';
}

export function resourceUrl(request?: Request): string {
  return `${publicBaseUrl(request)}${MCP_RESOURCE_PATH}`;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
