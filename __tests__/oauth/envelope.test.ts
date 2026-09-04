export {};
import { seal, open, ENVELOPE_PREFIX, looksLikeAccessEnvelope, nowSeconds } from '../../src/lib/oauth/envelope';
import { oauthEnabled, deriveKey, publicBaseUrl, resourceUrl } from '../../src/lib/oauth/config';

const KEY = 'unit-test-signing-key-with-at-least-32-bytes!!';

describe('OAuth config', () => {
  afterEach(() => {
    delete process.env.MCP_OAUTH_SIGNING_KEY;
    delete process.env.MCP_PUBLIC_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
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
