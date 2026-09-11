/**
 * The hosted sign-in pages' output safety (SPLIT-1420).
 *
 * `escapeHtml` is the ONLY thing standing between attacker-controlled strings
 * and the sign-in page's HTML: the client name and redirect URI come straight
 * off a `/oauth/register` body that anyone may POST, and the error text can
 * come from the backend. The page carries a password field, so an injected
 * script there is a credential-harvesting bug, not a defacement. Nothing
 * guarded the escaper before this file existed.
 */
export {};
import { escapeHtml, renderConsent, renderLoginPage, renderOtpPage, renderErrorPage, PAGE_HEADERS } from '../../src/lib/oauth/pages';
import { TOOL_SCOPES } from '../../src/lib/oauth/scopes';

const XSS = '"><script>alert(1)</script>';

describe('escapeHtml', () => {
  it('escapes every character that can break out of text OR attribute context', () => {
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml("'")).toBe('&#39;');
  });

  it('escapes the ampersand FIRST, so entities are not double-decoded', () => {
    // If `&` were replaced after `<`, the output would read `&amp;lt;` -> the
    // browser renders `&lt;`, and a second pass anywhere downstream renders
    // `<`. Order is load-bearing, not stylistic.
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
    expect(escapeHtml('<&>')).toBe('&lt;&amp;&gt;');
  });

  it('neutralises a script payload and an attribute break-out', () => {
    const escaped = escapeHtml(XSS);
    expect(escaped).not.toContain('<script');
    expect(escaped).not.toContain('">');
    expect(escaped).toBe('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');

    // The single-quote form matters too: an attribute value could be quoted
    // either way, and `'` closes it just as well as `"`.
    expect(escapeHtml("' onmouseover='alert(1)")).toBe('&#39; onmouseover=&#39;alert(1)');
    // A bare `javascript:` string is inert once it cannot escape its quotes.
    expect(escapeHtml('javascript:alert(1)')).toBe('javascript:alert(1)');
  });

  it('leaves multi-byte text intact and does not corrupt surrogate pairs', () => {
    expect(escapeHtml('Grüße aus München')).toBe('Grüße aus München');
    expect(escapeHtml('日本語のテキスト')).toBe('日本語のテキスト');
    expect(escapeHtml('🏕️ Camping 😀')).toBe('🏕️ Camping 😀');
    expect(escapeHtml('naïve café')).toBe('naïve café');
    // Multi-byte characters around a dangerous one are not a way past it.
    expect(escapeHtml('日<script>本')).toBe('日&lt;script&gt;本');
    expect(escapeHtml('😀"onerror=x')).toBe('😀&quot;onerror=x');
    // Escaping is idempotent in shape: no character is dropped or reordered.
    expect(escapeHtml('café & crème')).toBe('café &amp; crème');
  });

  it('handles the empty string and strings that need no escaping', () => {
    expect(escapeHtml('')).toBe('');
    expect(escapeHtml('Claude Desktop')).toBe('Claude Desktop');
  });
});

describe('sign-in page rendering', () => {
  const base = {
    requestToken: 'req-token',
    clientName: 'Test Client',
    redirectUri: 'https://client.example/callback',
    verified: true,
    scopes: ['read'] as const,
    scopesRequested: true,
    providers: [] as const,
  };

  it('escapes the client name, the redirect URI and the error in the rendered page', () => {
    const html = renderLoginPage({
      ...base,
      clientName: XSS,
      redirectUri: `https://client.example/cb?x=${XSS}`,
      email: XSS,
      error: XSS,
      scopes: ['read'],
      providers: [],
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    // The email is rendered INSIDE an attribute: the quote must be escaped or
    // the payload escapes the value and becomes markup.
    expect(html).not.toContain('value=""><script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('escapes untrusted text on the consent card, the OTP page and the error page', () => {
    expect(renderConsent({ clientName: XSS, verified: false, scopes: ['read'], scopesRequested: true })).not.toContain('<script>');
    expect(renderOtpPage({ challengeToken: XSS, maskedEmail: XSS, error: XSS })).not.toContain('<script>alert(1)</script>');
    expect(renderErrorPage(XSS, XSS)).not.toContain('<script>alert(1)</script>');
    // ...and the page title, which is rendered through the same shell.
    expect(renderErrorPage(XSS, 'ok')).toContain('&lt;script&gt;');
  });

  it('renders the full-access wording only when the client named no scopes', () => {
    expect(renderConsent({ clientName: 'App', verified: true, scopes: [...TOOL_SCOPES], scopesRequested: false })).toContain('asking for full access');
    expect(renderConsent({ clientName: 'App', verified: true, scopes: ['read'], scopesRequested: true })).not.toContain('asking for full access');
    expect(renderConsent({ clientName: 'App', verified: true, scopes: [], scopesRequested: true })).toContain('will not be able to do anything');
  });
});

describe('sign-in page response headers', () => {
  const csp = PAGE_HEADERS['Content-Security-Policy'];

  it("sets form-action 'self' so credentials cannot be posted to another origin", () => {
    // default-src does NOT cover form submission: without form-action, an
    // injected or rewritten <form action> could send the password field
    // anywhere. This is the directive that stops that.
    expect(csp).toContain("form-action 'self'");
  });

  it('keeps the rest of the strict policy intact', () => {
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("base-uri 'none'"); // no <base href> repointing action=""
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).not.toContain('script-src'); // no scripts are served at all
    expect(PAGE_HEADERS['X-Frame-Options']).toBe('DENY');
    expect(PAGE_HEADERS['X-Content-Type-Options']).toBe('nosniff');
    expect(PAGE_HEADERS['Referrer-Policy']).toBe('no-referrer');
    expect(PAGE_HEADERS['Cache-Control']).toBe('no-store');
  });
});
