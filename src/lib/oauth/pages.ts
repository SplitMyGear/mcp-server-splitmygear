/**
 * The hosted sign-in pages for the OAuth authorization endpoint. Server-rendered
 * HTML strings with inline CSS only (strict CSP: no scripts, no remote assets),
 * every dynamic value HTML-escaped. Deliberately minimal: email + password,
 * then an email one-time-code step when the account has 2FA on. The sign-in
 * page doubles as the consent screen: it lists what the app will be able to
 * do, one line per requested scope. Below the form, "Continue with Google /
 * Apple" are plain links (no script) to `/oauth/social/start`, one per
 * provider the backend reports configured.
 */
import { SCOPE_DESCRIPTIONS, type ToolScope } from './scopes';
import type { SocialProvider } from './backend-auth';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * `form-action` is the directive that matters most on a page that carries a
 * password field: `default-src 'none'` does NOT restrict form submission, so
 * without it any injected or rewritten `<form action>` could post the
 * credentials straight to another origin. `base-uri 'none'` already blocks the
 * `<base href>` trick that would repoint a relative form action.
 *
 * Browsers also apply `form-action` to the REDIRECTS that follow a form
 * submission (Chromium enforces it; CSP3 §6.3.1). A successful sign-in, the
 * two-step code and Cancel all answer the form POST with a 302 to the
 * client's redirect URI, so a bare `form-action 'self'` makes the browser
 * abort that hop: the user is left on the filled-in form and the
 * authorization code is lost, for every OAuth client. The pages that carry a
 * form therefore allow exactly one more origin: the one of the redirect URI
 * this request was already validated against (registered by the client,
 * https on an allow-listed host or loopback). Nothing else is added, so a
 * rewritten form still cannot post the password to an arbitrary origin.
 */
const BASE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; frame-ancestors 'none'";

/** The serialized origin of a validated redirect URI, or undefined when it is not a plain http(s) origin. */
function redirectOrigin(redirectUri: string | undefined): string | undefined {
  if (!redirectUri) return undefined;
  let origin: string;
  try {
    const url = new URL(redirectUri);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    origin = url.origin;
  } catch {
    return undefined;
  }
  // A URL origin can never carry CSP separators, but a header is not the place to trust that.
  return /^https?:\/\/[A-Za-z0-9.\-[\]:]+$/.test(origin) ? origin : undefined;
}

/**
 * Headers for a hosted page. Pass the (already validated) redirect URI of the
 * sign-in request for any page that contains a form whose submission can end
 * in a redirect to the client.
 *
 * `Referrer-Policy: same-origin`, not `no-referrer`: under `no-referrer` the
 * Fetch standard serialises the Origin of the page's own form POST as `null`,
 * which the same-origin check on /oauth/authorize (`isSameOriginPost`) then
 * refused, so no password sign-in could complete. `same-origin` sends the real
 * Origin to this server and still sends nothing to any other origin, including
 * the client the browser is redirected to afterwards.
 */
export function pageHeaders(redirectUri?: string): Record<string, string> {
  const extra = redirectOrigin(redirectUri);
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': `${BASE_CSP}; form-action 'self'${extra ? ` ${extra}` : ''}`,
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  };
}

/** Headers for pages without a sign-in request (error pages): form-action 'self' only. */
export const PAGE_HEADERS: Record<string, string> = pageHeaders();

/**
 * Both hosted forms post to the authorize endpoint EXPLICITLY. `action=""`
 * posts back to whatever URL rendered the page — and the social callback
 * (GET /oauth/social/callback, GET-only) renders this same sign-in page after
 * a failed provider round-trip, and the 2FA page after a successful one, so
 * the password fallback and the one-time code there used to 405. Same origin,
 * so `form-action 'self'` covers the form itself.
 */
export const SIGN_IN_FORM_ACTION = '/oauth/authorize';

const STYLES = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f4f6f4; color: #17211b; display: flex; min-height: 100vh; align-items: center; justify-content: center; padding: 24px; }
  main { width: 100%; max-width: 400px; background: #fff; border: 1px solid #dfe5e0; border-radius: 12px; padding: 28px; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  p { margin: 0 0 16px; color: #4b5a50; }
  .client { background: #eef5ef; border-radius: 8px; padding: 10px 12px; margin-bottom: 18px; font-size: 14px; }
  .client b { color: #17211b; }
  .client ul { margin: 6px 0 10px; padding-left: 18px; }
  .client summary { cursor: pointer; font-weight: 600; color: #1d5c3b; }
  .client[open] summary { margin-bottom: 6px; }
  .lede b { color: #17211b; }
  .client li { margin: 2px 0; }
  .full { display: block; font-weight: 600; margin-bottom: 4px; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 12px 0 6px; }
  input { width: 100%; padding: 10px 12px; font-size: 15px; border: 1px solid #b9c4bc; border-radius: 8px; background: #fff; color: inherit; }
  input:focus { outline: 2px solid #1d7a4c; outline-offset: 1px; }
  button { width: 100%; margin-top: 18px; padding: 11px; font-size: 15px; font-weight: 600; border: 0; border-radius: 8px; background: #1d7a4c; color: #fff; cursor: pointer; }
  button.secondary { background: transparent; color: #1d7a4c; margin-top: 8px; }
  .error { background: #fdecec; color: #8a1f1f; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; font-size: 14px; }
  .warn { background: #fff4de; color: #6b4a00; border-radius: 8px; padding: 10px 12px; margin-bottom: 14px; font-size: 13px; }
  .tag { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: .02em; text-transform: uppercase; background: #fff4de; color: #6b4a00; border-radius: 4px; padding: 1px 6px; vertical-align: middle; }
  code { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
  .hint { font-size: 13px; color: #6b7a70; margin-top: 14px; }
  .or { display: flex; align-items: center; gap: 10px; margin: 18px 0 4px; font-size: 12px; color: #6b7a70; text-transform: uppercase; letter-spacing: .04em; }
  .or::before, .or::after { content: ""; flex: 1; border-top: 1px solid #dfe5e0; }
  .social { display: block; width: 100%; margin-top: 8px; padding: 10px; font-size: 15px; font-weight: 600; text-align: center; text-decoration: none; border: 1px solid #b9c4bc; border-radius: 8px; background: #fff; color: #17211b; }
  .social:hover { background: #f4f6f4; }
  @media (prefers-color-scheme: dark) {
    body { background: #101512; color: #e8ede9; }
    main { background: #171d19; border-color: #2a332d; }
    p, .hint, .or { color: #a8b3ab; }
    .or::before, .or::after { border-color: #2a332d; }
    .client { background: #1f2a22; } .client b, .lede b { color: #e8ede9; } .client summary { color: #8fd1ad; }
    input { background: #0f1411; border-color: #3a463e; }
    .social { background: #0f1411; border-color: #3a463e; color: #e8ede9; }
    .social:hover { background: #1f2a22; }
    .error { background: #3a1d1d; color: #f5b5b5; }
    .warn, .tag { background: #3a2e12; color: #f2d48a; }
  }
`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} · Splitt</title>
<style>${STYLES}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

export interface LoginPageProps {
  requestToken: string;
  clientName: string;
  redirectUri: string;
  /** Loopback or operator allow-listed redirect host. */
  verified: boolean;
  /**
   * The redirect goes back to the user's own machine (http://localhost…):
   * a desktop app or CLI. The MCP authorization spec asks for an extra
   * warning here, because any local program can listen on a port and claim
   * to be the app.
   */
  loopback?: boolean;
  /** Scopes the app will be granted (listed one per line on the consent card). */
  scopes: readonly ToolScope[];
  /** false when the app sent no `scope` at all, i.e. it is asking for full access. */
  scopesRequested: boolean;
  /** Social providers the backend can serve; one "Continue with ..." link each. */
  providers: readonly SocialProvider[];
  email?: string;
  error?: string;
}

const PROVIDER_LABEL: Record<SocialProvider, string> = { google: 'Google', apple: 'Apple' };

/** Where "Continue with <provider>" sends the browser (same origin; the request rides along sealed). */
export function socialStartPath(provider: SocialProvider, requestToken: string): string {
  return `/oauth/social/start?provider=${provider}&req=${encodeURIComponent(requestToken)}`;
}

function renderSocialLinks(p: Pick<LoginPageProps, 'providers' | 'requestToken'>): string {
  if (p.providers.length === 0) {
    return '<p class="hint">Signed up with Google or Apple? Set a password first from your Splitt profile, then sign in here.</p>';
  }
  const links = p.providers
    .map((provider) => `<a class="social" href="${escapeHtml(socialStartPath(provider, p.requestToken))}">Continue with ${PROVIDER_LABEL[provider]}</a>`)
    .join('\n');
  return `<div class="or">or</div>\n${links}`;
}

/** The consent card body: what the app asked for, in the user's words. */
export function renderConsent(p: Pick<LoginPageProps, 'clientName' | 'verified' | 'scopes' | 'scopesRequested'>): string {
  const app = `<b>${escapeHtml(p.clientName)}</b>${p.verified ? '' : ' <span class="tag">unverified app</span>'}`;
  const items = p.scopes.map((s) => `<li>${escapeHtml(SCOPE_DESCRIPTIONS[s])}</li>`).join('');
  if (!p.scopesRequested) {
    return `<span class="full">${app} is asking for full access to your Splitt account.</span>It did not limit its request, so it will be able to do everything you can:<ul>${items}</ul>`;
  }
  if (p.scopes.length === 0) return `${app} will not be able to do anything with your account (it requested no usable permissions).`;
  return `${app} will be able to:<ul>${items}</ul>`;
}

/** Where the browser goes after sign-in, as a person reads it: the host, or "this computer" for loopback. */
function returnPlace(redirectUri: string, loopback: boolean): string {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return escapeHtml(redirectUri);
  }
  if (loopback) return `an app on this computer (<b>${escapeHtml(url.host)}</b>)`;
  return `<b>${escapeHtml(url.hostname)}</b>`;
}

/**
 * The sign-in page doubles as the consent screen. Layout, top to bottom: who
 * is asking and where the browser goes afterwards (always visible: the MCP
 * authorization spec wants the redirect host shown clearly), any warning, the
 * form, the social sign-in links, and the full list of what the app will be
 * able to do, one click away so the form stays above the fold on a phone.
 */
export function renderLoginPage(p: LoginPageProps): string {
  const app = `<b>${escapeHtml(p.clientName)}</b>${p.verified ? '' : ' <span class="tag">unverified app</span>'}`;
  const warnings = [
    p.verified ? '' : '<div class="warn">Splitt has not verified this app. Only continue if you started this sign-in yourself from an app you trust, and check the address below.</div>',
    p.loopback
      ? '<div class="warn">This app runs on your own computer. Only continue if you started this sign-in from an app on this device yourself.</div>'
      : '',
  ].join('');
  return shell(
    'Sign in',
    `<h1>Sign in to Splitt</h1>
<p class="lede">${app} wants to use your Splitt account. After you sign in you go back to ${returnPlace(p.redirectUri, p.loopback === true)}.</p>
${warnings}
<details class="client"><summary>What ${escapeHtml(p.clientName)} will be able to do</summary>${renderConsent(p)}After sign-in you will be sent to:<br><code>${escapeHtml(p.redirectUri)}</code></details>
${p.error ? `<div class="error" role="alert">${escapeHtml(p.error)}</div>` : ''}
<form method="post" action="${SIGN_IN_FORM_ACTION}" autocomplete="on">
<input type="hidden" name="step" value="login">
<input type="hidden" name="req" value="${escapeHtml(p.requestToken)}">
<label for="email">Email</label>
<input id="email" name="email" type="email" inputmode="email" autocomplete="username" required maxlength="254" value="${escapeHtml(p.email ?? '')}">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256">
<button type="submit">Continue</button>
<button type="submit" class="secondary" name="step" value="cancel" formnovalidate>Cancel</button>
</form>
${renderSocialLinks(p)}`,
  );
}

export interface OtpPageProps {
  challengeToken: string;
  maskedEmail: string;
  error?: string;
}

export function renderOtpPage(p: OtpPageProps): string {
  return shell(
    'Verify it\'s you',
    `<h1>Check your email</h1>
<p>We sent a one-time code to <b>${escapeHtml(p.maskedEmail || 'your email')}</b>. Enter it below to finish signing in.</p>
${p.error ? `<div class="error" role="alert">${escapeHtml(p.error)}</div>` : ''}
<form method="post" action="${SIGN_IN_FORM_ACTION}" autocomplete="off">
<input type="hidden" name="step" value="otp">
<input type="hidden" name="chal" value="${escapeHtml(p.challengeToken)}">
<label for="code">Verification code</label>
<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9A-Za-z]{4,10}" required maxlength="10">
<button type="submit">Verify</button>
<button type="submit" class="secondary" name="step" value="otp_resend" formnovalidate>Resend code</button>
</form>`,
  );
}

export function renderErrorPage(title: string, message: string): string {
  return shell(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}

export function renderDonePage(title: string, message: string): string {
  return shell(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}
