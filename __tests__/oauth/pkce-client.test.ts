export {};
import crypto from 'crypto';
import { verifyS256, s256Challenge, isValidCodeVerifier, isValidCodeChallenge } from '../../src/lib/oauth/pkce';
import { registerClient, resolveClient, clientAllowsRedirect, isAllowedRedirectUri, isVerifiedRedirectUri } from '../../src/lib/oauth/client';

const KEY = 'unit-test-signing-key-with-at-least-32-bytes!!';

describe('PKCE S256', () => {
  it('accepts a matching verifier/challenge pair and rejects mismatches', () => {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = s256Challenge(verifier);
    expect(isValidCodeVerifier(verifier)).toBe(true);
    expect(isValidCodeChallenge(challenge)).toBe(true);
    expect(verifyS256(verifier, challenge)).toBe(true);
    expect(verifyS256(verifier + 'x', challenge)).toBe(false);
    expect(verifyS256('short', challenge)).toBe(false);
    expect(verifyS256(verifier, 'plain-text-challenge')).toBe(false);
  });
});

describe('stateless client registration', () => {
  // An allow-list is now a precondition for registering any https host
  // (SPLIT-1420), so the default fixture is a configured server. Tests that
  // care about the UNCONFIGURED state clear it explicitly.
  beforeEach(() => {
    process.env.MCP_OAUTH_SIGNING_KEY = KEY;
    process.env.MCP_OAUTH_ALLOWED_REDIRECT_HOSTS = 'claude.ai, a.example, ok.example';
  });
  afterEach(() => {
    delete process.env.MCP_OAUTH_SIGNING_KEY;
    delete process.env.MCP_OAUTH_ALLOWED_REDIRECT_HOSTS;
  });

  it('accepts allow-listed https and loopback redirect URIs only', () => {
    expect(isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(isAllowedRedirectUri('http://localhost:8765/callback')).toBe(true);
    expect(isAllowedRedirectUri('http://127.0.0.1:9/cb')).toBe(true);
    expect(isAllowedRedirectUri('http://evil.example/cb')).toBe(false);
    expect(isAllowedRedirectUri('https://ok.example/cb#frag')).toBe(false);
    expect(isAllowedRedirectUri('javascript:alert(1)')).toBe(false);
    expect(isAllowedRedirectUri('not a url')).toBe(false);
  });

  it('mints a signed client id that resolves to the registered record', () => {
    const reg = registerClient({ client_name: 'Claude', redirect_uris: ['https://claude.ai/cb'], token_endpoint_auth_method: 'none' });
    expect('error' in reg).toBe(false);
    if ('error' in reg) return;
    const resolved = resolveClient(reg.client_id);
    expect(resolved?.client_name).toBe('Claude');
    expect(resolved?.redirect_uris).toEqual(['https://claude.ai/cb']);
    expect(clientAllowsRedirect(resolved!, 'https://claude.ai/cb')).toBe(true);
    expect(clientAllowsRedirect(resolved!, 'https://claude.ai/cb2')).toBe(false);
  });

  it('rejects a tampered client id (redirect URI swap) and foreign ids', () => {
    const reg = registerClient({ redirect_uris: ['https://claude.ai/cb'] });
    if ('error' in reg) throw new Error('unexpected');
    const [prefix, , sig] = reg.client_id.split('.');
    const forgedBody = Buffer.from(JSON.stringify({ ru: ['https://attacker.example/cb'], iat: 1 })).toString('base64url');
    expect(resolveClient(`${prefix}.${forgedBody}.${sig}`)).toBeNull();
    expect(resolveClient('random-client-id')).toBeNull();
    expect(resolveClient(undefined)).toBeNull();
    process.env.MCP_OAUTH_SIGNING_KEY = 'another-secret-that-is-also-long-enough-000';
    expect(resolveClient(reg.client_id)).toBeNull();
  });

  it('enforces the operator redirect-host allow-list and marks verified hosts', () => {
    delete process.env.MCP_OAUTH_ALLOWED_REDIRECT_HOSTS;
    expect(isVerifiedRedirectUri('https://claude.ai/cb')).toBe(false);
    expect(isVerifiedRedirectUri('http://localhost:1234/cb')).toBe(true);
    process.env.MCP_OAUTH_ALLOWED_REDIRECT_HOSTS = 'claude.ai, .cursor.com';
    expect(isAllowedRedirectUri('https://claude.ai/cb')).toBe(true);
    expect(isAllowedRedirectUri('https://www.claude.ai/cb')).toBe(false);
    expect(isAllowedRedirectUri('https://app.cursor.com/cb')).toBe(true);
    expect(isAllowedRedirectUri('https://cursor.com/cb')).toBe(true);
    expect(isAllowedRedirectUri('https://claude-login.example/cb')).toBe(false);
    expect(isAllowedRedirectUri('http://127.0.0.1:9/cb')).toBe(true);
    expect(isVerifiedRedirectUri('https://claude.ai/cb')).toBe(true);
    expect(registerClient({ redirect_uris: ['https://evil.example/cb'] })).toMatchObject({ error: 'invalid_redirect_uri' });
    delete process.env.MCP_OAUTH_ALLOWED_REDIRECT_HOSTS;
  });

  it('DENIES every https host when no allow-list is set, and says which variable to set', () => {
    // The regression this pins: an unset MCP_OAUTH_ALLOWED_REDIRECT_HOSTS used
    // to mean "any https host may register", which let anyone register a
    // lookalike client whose redirect_uri points at their own server and turn
    // /oauth/authorize on the real MCP origin into a phishing page.
    delete process.env.MCP_OAUTH_ALLOWED_REDIRECT_HOSTS;
    expect(isAllowedRedirectUri('https://claude.ai/cb')).toBe(false);
    expect(isAllowedRedirectUri('https://anything.example/cb')).toBe(false);
    expect(isAllowedRedirectUri('https://attacker.example/cb')).toBe(false);
    // Loopback is unaffected: it never leaves the user's own machine (RFC 8252).
    expect(isAllowedRedirectUri('http://localhost:8765/cb')).toBe(true);
    expect(isAllowedRedirectUri('http://127.0.0.1:9/cb')).toBe(true);
    expect(isAllowedRedirectUri('http://[::1]:9/cb')).toBe(true);

    const denied = registerClient({ client_name: 'Claude', redirect_uris: ['https://claude.ai/cb'] });
    expect(denied).toMatchObject({ error: 'invalid_redirect_uri' });
    // The operator has to be told WHY, or this looks like a malformed URI.
    expect((denied as { error_description: string }).error_description).toContain('MCP_OAUTH_ALLOWED_REDIRECT_HOSTS');
    // ...while a loopback client still registers, so local dev keeps working.
    expect('error' in registerClient({ redirect_uris: ['http://localhost:8765/cb'] })).toBe(false);
  });

  it('re-checks the allow-list on every use, so narrowing it revokes ids already issued', () => {
    const reg = registerClient({ client_name: 'Claude', redirect_uris: ['https://claude.ai/cb'] });
    if ('error' in reg) throw new Error('expected registration to succeed');
    expect(resolveClient(reg.client_id)?.client_name).toBe('Claude');

    // The operator drops claude.ai from the list: the signature is still
    // valid, but the id must stop resolving. This is what stands in for a
    // client-id expiry (see resolveClient).
    process.env.MCP_OAUTH_ALLOWED_REDIRECT_HOSTS = 'cursor.com';
    expect(resolveClient(reg.client_id)).toBeNull();

    // ...and it comes back when the policy allows it again.
    process.env.MCP_OAUTH_ALLOWED_REDIRECT_HOSTS = 'cursor.com, claude.ai';
    expect(resolveClient(reg.client_id)?.client_name).toBe('Claude');
  });

  it('rejects confidential clients, bad grants and bad metadata', () => {
    expect(registerClient(null)).toMatchObject({ error: 'invalid_client_metadata' });
    expect(registerClient({ redirect_uris: [] })).toMatchObject({ error: 'invalid_redirect_uri' });
    expect(registerClient({ redirect_uris: ['http://evil.example'] })).toMatchObject({ error: 'invalid_redirect_uri' });
    expect(registerClient({ redirect_uris: ['https://a.example'], token_endpoint_auth_method: 'client_secret_basic' })).toMatchObject({ error: 'invalid_client_metadata' });
    expect(registerClient({ redirect_uris: ['https://a.example'], grant_types: ['implicit'] })).toMatchObject({ error: 'invalid_client_metadata' });
    expect(registerClient({ redirect_uris: ['https://a.example'], response_types: ['token'] })).toMatchObject({ error: 'invalid_client_metadata' });
  });
});
