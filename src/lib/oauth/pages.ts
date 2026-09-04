/**
 * The hosted sign-in pages for the OAuth authorization endpoint. Server-rendered
 * HTML strings with inline CSS only (strict CSP: no scripts, no remote assets),
 * every dynamic value HTML-escaped. Deliberately minimal: email + password,
 * then an email one-time-code step when the account has 2FA on.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const PAGE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

const STYLES = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f4f6f4; color: #17211b; display: flex; min-height: 100vh; align-items: center; justify-content: center; padding: 24px; }
  main { width: 100%; max-width: 400px; background: #fff; border: 1px solid #dfe5e0; border-radius: 12px; padding: 28px; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  p { margin: 0 0 16px; color: #4b5a50; }
  .client { background: #eef5ef; border-radius: 8px; padding: 10px 12px; margin-bottom: 18px; font-size: 14px; }
  .client b { color: #17211b; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 12px 0 6px; }
  input { width: 100%; padding: 10px 12px; font-size: 15px; border: 1px solid #b9c4bc; border-radius: 8px; background: #fff; color: inherit; }
  input:focus { outline: 2px solid #1d7a4c; outline-offset: 1px; }
  button { width: 100%; margin-top: 18px; padding: 11px; font-size: 15px; font-weight: 600; border: 0; border-radius: 8px; background: #1d7a4c; color: #fff; cursor: pointer; }
  button.secondary { background: transparent; color: #1d7a4c; margin-top: 8px; }
  .error { background: #fdecec; color: #8a1f1f; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; font-size: 14px; }
  .hint { font-size: 13px; color: #6b7a70; margin-top: 14px; }
  @media (prefers-color-scheme: dark) {
    body { background: #101512; color: #e8ede9; }
    main { background: #171d19; border-color: #2a332d; }
    p, .hint { color: #a8b3ab; }
    .client { background: #1f2a22; } .client b { color: #e8ede9; }
    input { background: #0f1411; border-color: #3a463e; }
    .error { background: #3a1d1d; color: #f5b5b5; }
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
  redirectHost: string;
  email?: string;
  error?: string;
}

export function renderLoginPage(p: LoginPageProps): string {
  return shell(
    'Sign in',
    `<h1>Sign in to Splitt</h1>
<p>Connect your Splitt account so this assistant can act as you.</p>
<div class="client"><b>${escapeHtml(p.clientName)}</b> will be able to search gear, manage your bookings, listings and messages on your behalf. It will send you back to <b>${escapeHtml(p.redirectHost)}</b>.</div>
${p.error ? `<div class="error" role="alert">${escapeHtml(p.error)}</div>` : ''}
<form method="post" action="" autocomplete="on">
<input type="hidden" name="step" value="login">
<input type="hidden" name="req" value="${escapeHtml(p.requestToken)}">
<label for="email">Email</label>
<input id="email" name="email" type="email" inputmode="email" autocomplete="username" required maxlength="254" value="${escapeHtml(p.email ?? '')}">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256">
<button type="submit">Continue</button>
<button type="submit" class="secondary" name="step" value="cancel" formnovalidate>Cancel</button>
</form>
<p class="hint">Signed up with Google or Apple? Set a password first from your Splitt profile, then sign in here.</p>`,
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
<form method="post" action="" autocomplete="off">
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
