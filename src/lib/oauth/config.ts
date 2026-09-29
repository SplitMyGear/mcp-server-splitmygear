/**
 * OAuth 2.1 configuration for the MCP server (MCP authorization spec, RFC 9728
 * protected-resource metadata, RFC 8414 AS metadata, RFC 7591 DCR).
 *
 * The MCP server is BOTH the OAuth resource server (the MCP endpoint — see
 * `mcpResourcePath()` for which path is canonical on this deployment) and a
 * thin, STATELESS authorization server that fronts the Splitt backend's
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
import { requestUrl } from '@/lib/request-url';
import { sharedStoreEnabled, sharedStoreRequired } from '@/lib/shared-store';

/** Minimum length of the sealing secret; generate it with `openssl rand -base64 48`. */
const MIN_SECRET_LENGTH = 32;
/** A 32+ char secret with fewer distinct characters than this is a passphrase, not a key. */
const MIN_DISTINCT_CHARS = 12;

/**
 * The only two paths a deployment may serve the MCP endpoint at (SPLIT-1621).
 * Both are ALWAYS live on every deployment (src/app/mcp/route.ts and
 * src/app/api/mcp/route.ts are the same handler); `mcpResourcePath()` below
 * only picks which one is CANONICAL.
 */
export const MCP_RESOURCE_PATHS = ['/api/mcp', '/mcp'] as const;
type McpResourcePath = (typeof MCP_RESOURCE_PATHS)[number];
const DEFAULT_RESOURCE_PATH: McpResourcePath = '/api/mcp';

let invalidResourcePathWarned = false;

/**
 * Canonical path of the protected MCP resource, relative to the public base
 * URL (`MCP_RESOURCE_PATH`, SPLIT-1621). This only selects which of the two
 * always-served paths is CANONICAL — the one `resourceUrl()` names, the one
 * the RFC 9728 metadata advertises as `resource`, and the one `isOwnResource`
 * requires. Production sets `MCP_RESOURCE_PATH=/mcp`; every other deployment
 * leaves it unset and keeps the original `/api/mcp`.
 *
 * FAILS CLOSED to the default on anything else, rather than trusting an
 * arbitrary operator string as a URL path segment: an unrecognised value
 * would make `resourceUrl()` advertise a spelling that is still reachable
 * (both paths always answer) but was never meant to be the canonical one,
 * confusing clients that compare it against what they configured for no
 * visible reason. The bad value is logged once per cold instance — loud
 * enough to show up in Vercel's function logs — naming the variable, so a
 * typo (`/mcp/`, `mcp`, `/MCP`) is obvious instead of a silent mismatch.
 */
export function mcpResourcePath(): McpResourcePath {
  const raw = process.env.MCP_RESOURCE_PATH;
  if (raw === undefined) return DEFAULT_RESOURCE_PATH;
  if ((MCP_RESOURCE_PATHS as readonly string[]).includes(raw)) return raw as McpResourcePath;
  if (!invalidResourcePathWarned) {
    invalidResourcePathWarned = true;
    console.error(
      `[oauth] MCP_RESOURCE_PATH=${JSON.stringify(raw)} is not ${MCP_RESOURCE_PATHS.map((p) => `"${p}"`).join(' or ')}; ` +
        `using the default "${DEFAULT_RESOURCE_PATH}" instead. Fix or unset the variable.`,
    );
  }
  return DEFAULT_RESOURCE_PATH;
}

export function oauthSigningSecret(): string | undefined {
  const secret = process.env.MCP_OAUTH_SIGNING_KEY;
  if (!secret || secret.length < MIN_SECRET_LENGTH) return undefined;
  if (new Set(secret).size < MIN_DISTINCT_CHARS) return undefined;
  return secret;
}

/**
 * True when the OAuth layer is configured and may issue/validate artifacts.
 *
 * Two preconditions. The signing secret is unconditional — without it nothing
 * can be sealed. The shared store is conditional on the operator asking for it
 * (`MCP_REQUIRE_SHARED_STORE=1`): several of OAuth's security properties (the
 * sign-in failure throttle, the authorization-code single-use cache) are only
 * cross-instance when a shared store backs them, and an operator who wants
 * those enforced rather than best-effort can make their absence fatal instead
 * of merely loud. It is opt-in, not the default, because refusing by default
 * would take the only user-facing sign-in path offline over a paid dependency
 * — see the reasoning in `lib/shared-store.warnIfNoSharedStore`.
 */
export function oauthEnabled(): boolean {
  if (oauthSigningSecret() === undefined) return false;
  if (sharedStoreRequired() && !sharedStoreEnabled()) {
    warnOAuthDisabledWithoutStore();
    return false;
  }
  return true;
}

let storeGateWarned = false;
function warnOAuthDisabledWithoutStore(): void {
  if (storeGateWarned) return;
  storeGateWarned = true;
  console.warn(
    '[oauth] DISABLED: MCP_REQUIRE_SHARED_STORE=1 but no shared store is configured. ' +
      'Every OAuth endpoint will fail closed until UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN ' +
      '(or the Vercel KV equivalents) are set, or the requirement is lifted.',
  );
}

/** Test hook: forget this module's one-shot warnings (the OAuth/store gate, an invalid MCP_RESOURCE_PATH). */
export function _resetOAuthConfigForTests(): void {
  storeGateWarned = false;
  invalidResourcePathWarned = false;
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
      return requestUrl(request).origin;
    } catch {
      /* fall through */
    }
  }
  return 'http://localhost:3000';
}

export function resourceUrl(request?: Request): string {
  return `${publicBaseUrl(request)}${mcpResourcePath()}`;
}

/**
 * Is `value` an RFC 8707 resource indicator for THIS server? The canonical
 * value is the MCP endpoint (`resourceUrl`, what the protected-resource
 * metadata advertises and what Claude sends). ChatGPT's documentation shows it
 * sending the server's bare origin instead, and clients differ on a trailing
 * slash, so both the endpoint and the origin are accepted, with or without
 * one. This authorization server protects exactly one resource, so every form
 * names the same audience; what must still fail is a DIFFERENT resource (a
 * token requested for another server), a fragment, or a value that is not a URL.
 * Host case is normalised by URL parsing; the path is compared exactly.
 *
 * SPLIT-1621: `own.pathname` is `resourceUrl`'s CANONICAL path, so when
 * `MCP_RESOURCE_PATH` picks `/mcp` this rejects `/api/mcp` and vice versa,
 * even though both are live endpoints on every deployment — a resource
 * indicator names the canonical spelling, not every path that happens to work.
 */
export function isOwnResource(value: string, request?: Request): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  const own = new URL(resourceUrl(request));
  if (url.origin !== own.origin) return false;
  const path = url.pathname.replace(/\/+$/, '');
  return path === '' || path === own.pathname.replace(/\/+$/, '');
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
 * REQUIRED allow-list of redirect targets for dynamic client registration
 * (`MCP_OAUTH_ALLOWED_REDIRECT_HOSTS`, comma-separated). An entry is a host
 * (`claude.ai`), a host and its subdomains (`.claude.com`), or either of those
 * followed by a path prefix (`claude.ai/api/mcp/auth_callback`), which pins
 * registrations to that path. Loopback is always allowed.
 *
 * EMPTY MEANS DENY (SPLIT-1420). It used to mean "allow any https host", which
 * let anyone register a client called "Claude" whose redirect_uri points at
 * their own server: `/oauth/authorize` on the real MCP origin then renders a
 * genuine Splitt sign-in page that hands the resulting code to the attacker.
 * An unset environment variable must not be what stands between a deployment
 * and an open redirector, so the default is now the safe one and an operator
 * opts IN to each host they trust.
 *
 * PIN THE PATH in production (RFC 9700 §4.1). Registration is open to anyone,
 * so a host-only entry lets a stranger register ANY path on that host; if the
 * host ever serves an open redirect, or a page whose URL other parties can
 * read, a sign-in the stranger started would deliver the victim's code there.
 * A path entry limits registrations to the one callback the client documents.
 */
export interface RedirectAllowEntry {
  /** Lowercase host, without the leading dot. */
  host: string;
  /** Leading dot: the host itself and any subdomain. */
  subdomains: boolean;
  /** Path prefix the redirect must sit under (segment boundary), or null for any path. */
  path: string | null;
}

export function allowedRedirectEntries(): RedirectAllowEntry[] {
  return (process.env.MCP_OAUTH_ALLOWED_REDIRECT_HOSTS || '')
    .split(',')
    // An operator may paste a full callback URL; the scheme is implied (https).
    .map((raw) => raw.trim().replace(/^https?:\/\//i, ''))
    .filter(Boolean)
    .map((raw) => {
      const slash = raw.indexOf('/');
      const hostPart = (slash === -1 ? raw : raw.slice(0, slash)).toLowerCase();
      const pathPart = slash === -1 ? '' : raw.slice(slash).replace(/\/+$/, '');
      const subdomains = hostPart.startsWith('.');
      return { host: subdomains ? hostPart.slice(1) : hostPart, subdomains, path: pathPart || null };
    })
    .filter((entry) => entry.host.length > 0);
}

/** The configured entries as written (for error messages and docs). */
export function allowedRedirectHosts(): string[] {
  return (process.env.MCP_OAUTH_ALLOWED_REDIRECT_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** A path segment made only of unreserved characters (RFC 3986) and not a dot segment. */
const PLAIN_SEGMENT = /^[A-Za-z0-9._~-]+$/;
const DOTS_ONLY = /^\.+$/;

/**
 * Is this redirect on the operator's allow-list? (false when no list is set)
 * Host rules match exactly, or as a real subdomain for a leading-dot entry.
 *
 * A PATH entry pins more than the path, because its whole point is that no
 * other page on the host can receive a code: the redirect must use the
 * default port and carry no query and no user info, and its path must be
 * the prefix itself or the prefix followed by plain segments
 * (`/connector/oauth` admits `/connector/oauth/abc123`, never
 * `/connector/oauthx`). "Plain" means unreserved characters only and no dot
 * segment, which refuses what the URL parser leaves in place but a
 * destination server might still decode or strip before resolving dots
 * (`%2F`, `%5C`, `;` path parameters, `..`). Paths compare case-sensitively,
 * as the parser normalises them.
 */
export function isAllowListedRedirect(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return allowedRedirectEntries().some((entry) => {
    const hostOk = host === entry.host || (entry.subdomains && host.endsWith(`.${entry.host}`));
    if (!hostOk) return false;
    if (entry.path === null) return true;
    if (url.port !== '' || url.search !== '' || url.username !== '' || url.password !== '') return false;
    if (url.pathname === entry.path) return true;
    if (!url.pathname.startsWith(`${entry.path}/`)) return false;
    return url.pathname
      .slice(entry.path.length + 1)
      .split('/')
      .every((segment) => PLAIN_SEGMENT.test(segment) && !DOTS_ONLY.test(segment));
  });
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
