/**
 * OAuth 2.1 configuration for the MCP server (MCP authorization spec, RFC 9728
 * protected-resource metadata, RFC 8414 AS metadata, RFC 7591 DCR).
 *
 * The MCP server is BOTH the OAuth resource server (the `/api/mcp` endpoint)
 * and a thin, STATELESS authorization server that fronts the Splitt backend's
 * own login (`POST /users/login`, email-OTP 2FA, `POST /auth/refresh`). It
 * never stores sessions: every artifact it hands out (authorization code,
 * access token, refresh token, registered client id, in-flight login request)
 * is an AES-256-GCM envelope sealed with a key derived from
 * `MCP_OAUTH_SIGNING_KEY`, so any serverless instance can validate what any
 * other instance issued.
 *
 * OAuth is OPT-IN: without `MCP_OAUTH_SIGNING_KEY` every OAuth endpoint fails
 * closed (404/503) and the server keeps working with the operator API key and
 * verified backend JWT bearer paths exactly as before.
 */
import crypto from 'crypto';
import net from 'net';

/** Minimum length of the sealing secret; generate it with `openssl rand -base64 48`. */
const MIN_SECRET_LENGTH = 32;
/** A 32+ char secret with fewer distinct characters than this is a passphrase, not a key. */
const MIN_DISTINCT_CHARS = 12;

/** Path of the protected MCP resource, relative to the public base URL. */
export const MCP_RESOURCE_PATH = '/api/mcp';

export function oauthSigningSecret(): string | undefined {
  const secret = process.env.MCP_OAUTH_SIGNING_KEY;
  if (!secret || secret.length < MIN_SECRET_LENGTH) return undefined;
  if (new Set(secret).size < MIN_DISTINCT_CHARS) return undefined;
  return secret;
}

/** True when the OAuth layer is configured and may issue/validate artifacts. */
export function oauthEnabled(): boolean {
  return oauthSigningSecret() !== undefined;
}

/**
 * Which deployment the sealed artifacts belong to. Bound into every derived
 * key so a token, code or client id sealed by a preview deployment (or a
 * local dev server) sharing the same secret is never valid in production.
 */
function environmentBinding(): string {
  return process.env.MCP_PUBLIC_URL || process.env.VERCEL_URL || 'local';
}

/**
 * Derive a purpose-bound 32-byte key from the operator secret (HKDF-SHA256).
 * Each purpose (`envelope:code`, `envelope:at`, `client`, ...) gets its own key
 * so an artifact sealed for one purpose can never be replayed as another (a
 * code is not an access token), and the environment binding keeps deployments
 * apart.
 */
export function deriveKey(purpose: string): Buffer {
  const secret = oauthSigningSecret();
  if (!secret) throw new Error('OAuth is not configured (MCP_OAUTH_SIGNING_KEY)');
  return Buffer.from(crypto.hkdfSync('sha256', secret, `splitt-mcp:${environmentBinding()}`, purpose, 32));
}

/**
 * The public base URL of THIS server (issuer + resource origin). Resolution
 * order: explicit `MCP_PUBLIC_URL` → Vercel's production URL (production
 * deployments only) → Vercel's per-deployment URL (previews) → the incoming
 * request's origin (local dev only). The issuer must be a stable,
 * operator-controlled value in production: a client discovering metadata is
 * told where to send the user and the tokens, so it must never be derived
 * from an attacker-influenced Host header there.
 */
export function publicBaseUrl(request?: Request): string {
  const explicit = process.env.MCP_PUBLIC_URL;
  if (explicit) return stripTrailingSlash(explicit);
  if (process.env.VERCEL_ENV === 'production' && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${stripTrailingSlash(process.env.VERCEL_PROJECT_PRODUCTION_URL)}`;
  }
  if (process.env.VERCEL_URL) return `https://${stripTrailingSlash(process.env.VERCEL_URL)}`;
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

/**
 * Whether `x-real-ip` / `x-forwarded-for` may be believed. Vercel's edge
 * overwrites them with the real peer address; anywhere else they are
 * attacker-controlled unless an operator explicitly fronts the server with a
 * proxy that sets them (`MCP_TRUST_PROXY_HEADERS=1`).
 */
export function trustProxyHeaders(): boolean {
  return process.env.VERCEL === '1' || process.env.MCP_TRUST_PROXY_HEADERS === '1';
}

/** A syntactically valid IPv4/IPv6 address, or undefined. */
export function validIp(value: string | null | undefined): string | undefined {
  // `x-forwarded-for` grows by appending: a trusted proxy adds the address it
  // saw at the END, while anything the client sent arrives at the front. The
  // rightmost entry is therefore the only one the proxy vouches for.
  const parts = (value ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  const v = parts[parts.length - 1];
  return v && net.isIP(v) ? v : undefined;
}

/**
 * Optional allow-list of redirect hosts for dynamic client registration
 * (`MCP_OAUTH_ALLOWED_REDIRECT_HOSTS`, comma-separated; a leading dot allows
 * subdomains, e.g. `claude.ai,.claude.com`). Loopback is always allowed.
 * Unset = any https host may register, and the sign-in page labels the app
 * as unverified.
 */
export function allowedRedirectHosts(): string[] {
  return (process.env.MCP_OAUTH_ALLOWED_REDIRECT_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** Is this redirect host on the operator's allow-list? (false when no list is set) */
export function isAllowListedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return allowedRedirectHosts().some((allowed) =>
    allowed.startsWith('.') ? host === allowed.slice(1) || host.endsWith(allowed) : host === allowed,
  );
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
