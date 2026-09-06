export {};
import crypto from 'crypto';
import { seal, open, ENVELOPE_PREFIX, looksLikeAccessEnvelope, nowSeconds } from '../../src/lib/oauth/envelope';
import { oauthEnabled, deriveKey, publicBaseUrl, resourceUrl, validIp, _resetOAuthConfigForTests } from '../../src/lib/oauth/config';
import { SCOPE_DESCRIPTIONS, TOOL_SCOPES, parseScopeParam, formatScope, isSubset, coerceScopes } from '../../src/lib/oauth/scopes';
import { issueAuthorizationCode, openAuthorizationCode, issueTokens, openAccessToken, openRefreshToken } from '../../src/lib/oauth/tokens';
import { authorizationServerMetadata, protectedResourceMetadata } from '../../src/lib/oauth/metadata';

const KEY = 'unit-test-signing-key-with-at-least-32-bytes!!';

describe('OAuth config', () => {
  afterEach(() => {
    delete process.env.MCP_OAUTH_SIGNING_KEY;
    delete process.env.MCP_PUBLIC_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    delete process.env.MCP_REQUIRE_SHARED_STORE;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    _resetOAuthConfigForTests();
    jest.restoreAllMocks();
  });

  it('runs WITHOUT a shared store by default: degraded, but serving (SPLIT-1420)', () => {
    // The judgement call this pins. OAuth's throttle and code-replay cache are
    // only cross-instance with a shared store, but refusing to serve without
    // one would take the only user-facing sign-in path offline over a paid
    // dependency -- while the controls that actually stand between an attacker
    // and an account (the backend's own throttles, mandatory PKCE S256) are
    // unaffected. So the default is: serve, and say so loudly.
    process.env.MCP_OAUTH_SIGNING_KEY = KEY;
    expect(oauthEnabled()).toBe(true);
  });

  it('refuses to enable at all when the operator demands a shared store and there is none', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.MCP_OAUTH_SIGNING_KEY = KEY;
    process.env.MCP_REQUIRE_SHARED_STORE = '1';
    expect(oauthEnabled()).toBe(false);
    // ...and the operator is told why, once, rather than silently losing OAuth.
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('MCP_REQUIRE_SHARED_STORE=1');
    oauthEnabled();
    oauthEnabled();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('[oauth] DISABLED'))).toHaveLength(1);

    // Configure the store and it comes back.
    process.env.UPSTASH_REDIS_REST_URL = 'https://example-redis.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    expect(oauthEnabled()).toBe(true);

    // The Vercel KV names satisfy the requirement too.
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.KV_REST_API_URL = 'https://example-kv.upstash.io';
    process.env.KV_REST_API_TOKEN = 'token';
    expect(oauthEnabled()).toBe(true);
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;

    // A signing key is still required regardless of the store.
    delete process.env.MCP_OAUTH_SIGNING_KEY;
    expect(oauthEnabled()).toBe(false);
  });

  it('is disabled without a signing key, with a short one, and with a low-entropy one', () => {
    expect(oauthEnabled()).toBe(false);
    process.env.MCP_OAUTH_SIGNING_KEY = 'too-short';
    expect(oauthEnabled()).toBe(false);
    process.env.MCP_OAUTH_SIGNING_KEY = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(oauthEnabled()).toBe(false);
    expect(() => deriveKey('x')).toThrow(/not configured/);
  });

  it('binds derived keys to the deployment (MCP_PUBLIC_URL / VERCEL_URL)', () => {
    process.env.MCP_OAUTH_SIGNING_KEY = KEY;
    const local = deriveKey('a');
    process.env.MCP_PUBLIC_URL = 'https://mcp.go-splitt.com';
    expect(deriveKey('a').equals(local)).toBe(false);
  });

  it('derives distinct purpose-bound keys from one secret', () => {
    process.env.MCP_OAUTH_SIGNING_KEY = KEY;
    expect(oauthEnabled()).toBe(true);
    expect(deriveKey('a').equals(deriveKey('a'))).toBe(true);
    expect(deriveKey('a').equals(deriveKey('b'))).toBe(false);
    expect(deriveKey('a').length).toBe(32);
  });

  it('believes only the rightmost x-forwarded-for entry (the one the proxy appended) and only when it is an IP', () => {
    expect(validIp('203.0.113.9')).toBe('203.0.113.9');
    expect(validIp(' 10.0.0.1, 198.51.100.7 , 203.0.113.9 ')).toBe('203.0.113.9');
    expect(validIp('2001:db8::1')).toBe('2001:db8::1');
    // A client-supplied prefix cannot smuggle an address past the proxy's own entry.
    expect(validIp('198.51.100.7, not-an-ip')).toBeUndefined();
    expect(validIp('198.51.100.7,')).toBe('198.51.100.7');
    expect(validIp('')).toBeUndefined();
    expect(validIp(null)).toBeUndefined();
    expect(validIp(undefined)).toBeUndefined();
  });

  it('resolves the public base URL from env before the request origin, previews never advertise production', () => {
    const req = new Request('https://example-mcp.test/api/mcp');
    expect(publicBaseUrl(req)).toBe('https://example-mcp.test');
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'mcp.vercel.app';
    process.env.VERCEL_URL = 'mcp-git-preview.vercel.app';
    process.env.VERCEL_ENV = 'preview';
    expect(publicBaseUrl(req)).toBe('https://mcp-git-preview.vercel.app');
    process.env.VERCEL_ENV = 'production';
    expect(publicBaseUrl(req)).toBe('https://mcp.vercel.app');
    process.env.MCP_PUBLIC_URL = 'https://mcp.go-splitt.com/';
    expect(publicBaseUrl(req)).toBe('https://mcp.go-splitt.com');
    expect(resourceUrl(req)).toBe('https://mcp.go-splitt.com/api/mcp');
    delete process.env.VERCEL_URL;
    delete process.env.VERCEL_ENV;
  });
});

describe('sealed envelopes', () => {
  beforeEach(() => { process.env.MCP_OAUTH_SIGNING_KEY = KEY; });
  afterEach(() => { delete process.env.MCP_OAUTH_SIGNING_KEY; });

  it('round-trips a payload with the kind prefix', () => {
    const iat = nowSeconds();
    const token = seal('at', { sub: 'u1', iat, exp: iat + 60 });
    expect(token.startsWith(`${ENVELOPE_PREFIX.at}.`)).toBe(true);
    expect(looksLikeAccessEnvelope(token)).toBe(true);
    expect(open<{ sub: string }>('at', token)?.sub).toBe('u1');
  });

  it('rejects the wrong kind, tampering, garbage and expiry', () => {
    const iat = nowSeconds();
    const token = seal('code', { sub: 'u1', iat, exp: iat + 60 });
    expect(open('at', token)).toBeNull();
    expect(open('code', token.slice(0, -2) + 'zz')).toBeNull();
    expect(open('code', `${ENVELOPE_PREFIX.code}.not-base64!!`)).toBeNull();
    expect(open('code', 'smg_ac.')).toBeNull();
    expect(open('code', undefined)).toBeNull();
    const expired = seal('code', { sub: 'u1', iat: iat - 120, exp: iat - 1 });
    expect(open('code', expired)).toBeNull();
  });

  it('is unreadable under a different secret', () => {
    const iat = nowSeconds();
    const token = seal('rt', { sub: 'u1', iat, exp: iat + 60 });
    process.env.MCP_OAUTH_SIGNING_KEY = 'another-secret-that-is-also-long-enough-000';
    expect(open('rt', token)).toBeNull();
  });
});

describe('OAuth scopes', () => {
  it('describes every scope in one plain sentence, without em-dashes', () => {
    for (const s of TOOL_SCOPES) {
      expect(SCOPE_DESCRIPTIONS[s]).toMatch(/^[A-Z].*\.$/);
      expect(SCOPE_DESCRIPTIONS[s]).not.toMatch(/—/);
    }
    expect(Object.keys(SCOPE_DESCRIPTIONS).sort()).toEqual([...TOOL_SCOPES].sort());
  });

  it('parses the RFC 6749 scope parameter: absent = everything (not requested), duplicates collapse, order is canonical', () => {
    expect(parseScopeParam(undefined)).toEqual({ ok: true, scopes: [...TOOL_SCOPES], requested: false });
    expect(parseScopeParam('')).toEqual({ ok: true, scopes: [...TOOL_SCOPES], requested: false });
    expect(parseScopeParam('   ')).toEqual({ ok: true, scopes: [...TOOL_SCOPES], requested: false });
    expect(parseScopeParam('bookings read  read')).toEqual({ ok: true, scopes: ['read', 'bookings'], requested: true });
    expect(parseScopeParam(TOOL_SCOPES.join(' '))).toEqual({ ok: true, scopes: [...TOOL_SCOPES], requested: true });
    const bad = parseScopeParam('read admin READ');
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).toContain('"admin"');
      expect(bad.error).toContain('"READ"'); // case-sensitive per the RFC
      expect(bad.error).toContain('supported scopes');
    }
  });

  it('formats, compares and coerces scope lists', () => {
    expect(formatScope(['bookings', 'read', 'bookings'])).toBe('read bookings');
    expect(formatScope([])).toBe('');
    expect(isSubset(['read'], ['read', 'bookings'])).toBe(true);
    expect(isSubset(['read', 'messaging'], ['read', 'bookings'])).toBe(false);
    expect(isSubset([], ['read'])).toBe(true);
    // SPLIT-1420: anything that is not a scope LIST grants nothing. This is an
    // authorization decision over untrusted-shaped data, so it fails closed;
    // it used to return the whole taxonomy, i.e. a silent full-access grant.
    expect(coerceScopes(undefined)).toEqual([]);
    expect(coerceScopes(null)).toEqual([]);
    expect(coerceScopes('read')).toEqual([]);
    expect(coerceScopes(42)).toEqual([]);
    expect(coerceScopes({ 0: 'read', length: 1 })).toEqual([]);
    // A present list is filtered to known scopes; an empty list stays empty (may use no tools).
    expect(coerceScopes(['finance', 'nope', 42, 'read'])).toEqual(['read', 'finance']);
    expect(coerceScopes([])).toEqual([]);
  });

  it('advertises scopes_supported in both discovery documents', () => {
    expect(protectedResourceMetadata('https://mcp.test').scopes_supported).toEqual([...TOOL_SCOPES]);
    expect(authorizationServerMetadata('https://mcp.test').scopes_supported).toEqual([...TOOL_SCOPES]);
  });
});

describe('scoped token envelopes', () => {
  const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const backendJwt = (payload: Record<string, unknown>) => `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg(payload)}.sig`;
  const user = { id: 'u1', role: 'renter', email: 'r@x.test' };
  beforeEach(() => { process.env.MCP_OAUTH_SIGNING_KEY = KEY; });
  afterEach(() => { delete process.env.MCP_OAUTH_SIGNING_KEY; });

  it('carries the granted scopes through code, access and refresh tokens and echoes them in the response', () => {
    const at = backendJwt({ sub: 'u1', role: 'renter', exp: nowSeconds() + 600 });
    const code = issueAuthorizationCode({ clientId: 'c', redirectUri: 'https://c/cb', codeChallenge: 'x'.repeat(43), user, backendAccessToken: at, backendRefreshToken: 'brt', scopes: ['bookings', 'read', 'read'] });
    const opened = openAuthorizationCode(code)!;
    expect(opened.sc).toEqual(['read', 'bookings']);
    const tokens = issueTokens({ clientId: 'c', user, backendAccessToken: at, backendRefreshToken: 'brt', scopes: opened.sc })!;
    expect(tokens.scope).toBe('read bookings');
    expect(openAccessToken(tokens.access_token)!.scp).toEqual(['read', 'bookings']);
    expect(openRefreshToken(tokens.refresh_token)!.scp).toEqual(['read', 'bookings']);
  });

  it('treats an envelope with no scope list as granting NOTHING, not everything (SPLIT-1420)', () => {
    const iat = nowSeconds();
    const at = backendJwt({ sub: 'u1', role: 'renter', exp: iat + 600 });
    // Such an envelope predates scopes. It used to be read as an unrestricted
    // grant, so a single missing field silently unlocked every tool; now it
    // unlocks none and the client simply re-authorizes.
    const legacyAccess = seal('at', { sub: 'u1', role: 'renter', email: 'e', cid: 'c', bt: at, iat, exp: iat + 600 });
    expect(openAccessToken(legacyAccess)!.scp).toEqual([]);
    const legacyRefresh = seal('rt', { sub: 'u1', role: 'renter', email: 'e', cid: 'c', brt: 'brt', bt: at, iat, exp: iat + 600 });
    expect(openRefreshToken(legacyRefresh)!.scp).toEqual([]);
    const legacyCode = seal('code', { cid: 'c', ru: 'https://c/cb', cc: 'x'.repeat(43), sub: 'u1', role: 'renter', email: 'e', at, rt: 'brt', jti: crypto.randomBytes(8).toString('hex'), iat, exp: iat + 60 });
    expect(openAuthorizationCode(legacyCode)!.sc).toEqual([]);
    // A code envelope missing its essentials is still rejected.
    expect(openAuthorizationCode(seal('code', { iat, exp: iat + 60 }))).toBeNull();
  });
});
