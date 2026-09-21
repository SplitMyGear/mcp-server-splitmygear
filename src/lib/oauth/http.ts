import { trustProxyHeaders, validIp } from './config';

/**
 * Small HTTP helpers shared by the OAuth route handlers: JSON + OAuth error
 * responses (RFC 6749 §5.2 shape), permissive CORS for the public discovery /
 * token / registration endpoints (browser-hosted MCP clients need it; nothing
 * on these endpoints is cookie-authenticated so `*` is safe), and a tolerant
 * body parser (form-urlencoded per spec, JSON accepted for convenience).
 */

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, mcp-protocol-version',
  'Access-Control-Max-Age': '86400',
};

export const NO_STORE: Record<string, string> = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...NO_STORE, ...headers },
  });
}

export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  | 'invalid_target'
  | 'access_denied'
  | 'unsupported_response_type'
  | 'server_error'
  | 'temporarily_unavailable'
  | 'invalid_redirect_uri'
  | 'invalid_client_metadata';

export function oauthError(error: OAuthErrorCode, description: string, status = 400): Response {
  return json({ error, error_description: description }, status);
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** Largest form/JSON body any OAuth endpoint accepts (tokens are < 2 KB). */
export const MAX_PARAMS_BYTES = 64 * 1024;

/** True when the declared Content-Length exceeds `limit` (unknown length passes). */
export function exceedsContentLength(request: Request, limit: number): boolean {
  const declared = Number(request.headers.get('content-length'));
  return Number.isFinite(declared) && declared > limit;
}

/** Parse `application/x-www-form-urlencoded` (or JSON) into a flat string map. */
export async function readParams(request: Request): Promise<Record<string, string>> {
  const contentType = request.headers.get('content-type') || '';
  const out: Record<string, string> = {};
  if (exceedsContentLength(request, MAX_PARAMS_BYTES)) return out;
  const text = await request.text();
  if (text.length > MAX_PARAMS_BYTES) return out;
  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string') out[k] = v;
          else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
        }
      }
    } catch {
      /* empty */
    }
    return out;
  }
  const usp = new URLSearchParams(text);
  for (const [k, v] of usp.entries()) out[k] = v;
  return out;
}

/**
 * The end user's IP, only when the proxy headers can be trusted (Vercel, or an
 * explicit operator opt-in) and the value is a real IP address. Undefined
 * otherwise: callers must then neither relay an IP nor key throttles on it.
 */
export function clientIp(request: Request): string | undefined {
  if (!trustProxyHeaders()) return undefined;
  return validIp(request.headers.get('x-real-ip')) ?? validIp(request.headers.get('x-forwarded-for'));
}

/**
 * Browser-submitted forms must come from THIS origin. Browsers always send
 * `Origin` (and `Sec-Fetch-Site`) on cross-site POSTs and neither can be set
 * by page script, so this blocks a hostile page from driving the sign-in form
 * with its visitors' browsers (distributed credential guessing, login CSRF).
 * Requests without either header (non-browser clients) are allowed through;
 * they are covered by the throttles instead.
 */
export function isSameOriginPost(request: Request): boolean {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
  const origin = request.headers.get('origin');
  if (origin) {
    let requestOrigin: string;
    try {
      requestOrigin = new URL(request.url).origin;
    } catch {
      return false;
    }
    if (origin.toLowerCase() !== requestOrigin.toLowerCase()) return false;
  }
  return true;
}
