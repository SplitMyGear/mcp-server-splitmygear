import crypto from 'crypto';
import { readBackendJwtClaims, verifyBackendJwtClaims, decodeBackendJwtClaims } from '../src/lib/jwt';

function b64url(o: object): string {
  return Buffer.from(JSON.stringify(o)).toString('base64url');
}
function makeToken(payload: object, secret?: string): string {
  const signingInput = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}`;
  const sig = secret ? crypto.createHmac('sha256', secret).update(signingInput).digest('base64url') : 'sig';
  return `${signingInput}.${sig}`;
}
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

describe('readBackendJwtClaims', () => {
  const original = process.env.MCP_BACKEND_JWT_SECRET;
  afterEach(() => {
    if (original === undefined) delete process.env.MCP_BACKEND_JWT_SECRET;
    else process.env.MCP_BACKEND_JWT_SECRET = original;
  });

  it('decodes sub/role from a well-formed token when no secret is configured', () => {
    delete process.env.MCP_BACKEND_JWT_SECRET;
    const claims = readBackendJwtClaims(makeToken({ sub: 'u1', role: 'vendor', exp: FUTURE }));
    expect(claims?.sub).toBe('u1');
    expect(claims?.role).toBe('vendor');
  });

  it('returns null for a malformed token', () => {
    expect(readBackendJwtClaims('not-a-jwt')).toBeNull();
    expect(readBackendJwtClaims('only.two')).toBeNull();
  });

  it('returns null for an expired token', () => {
    delete process.env.MCP_BACKEND_JWT_SECRET;
    expect(readBackendJwtClaims(makeToken({ sub: 'u1', exp: Math.floor(Date.now() / 1000) - 1 }))).toBeNull();
  });

  it('verifies the HS256 signature when MCP_BACKEND_JWT_SECRET is set', () => {
    process.env.MCP_BACKEND_JWT_SECRET = 'shared-secret';
    expect(readBackendJwtClaims(makeToken({ sub: 'u1', exp: FUTURE }, 'shared-secret'))?.sub).toBe('u1');
    // A token signed with the wrong key (forged) is rejected.
    expect(readBackendJwtClaims(makeToken({ sub: 'attacker', exp: FUTURE }, 'wrong-secret'))).toBeNull();
  });
});

describe('verifyBackendJwtClaims / decodeBackendJwtClaims', () => {
  afterEach(() => { delete process.env.MCP_BACKEND_JWT_SECRET; });

  it('verify returns null without a configured secret, even for a well-formed token', () => {
    delete process.env.MCP_BACKEND_JWT_SECRET;
    expect(verifyBackendJwtClaims(makeToken({ sub: 'u1', exp: FUTURE }, 'whatever'))).toBeNull();
  });

  it('verify rejects a non-HS256 header (alg confusion) and accepts a correctly signed token', () => {
    process.env.MCP_BACKEND_JWT_SECRET = 'shared-secret';
    const signingInput = `${b64url({ alg: 'none' })}.${b64url({ sub: 'u1', exp: FUTURE })}`;
    const sig = crypto.createHmac('sha256', 'shared-secret').update(signingInput).digest('base64url');
    expect(verifyBackendJwtClaims(`${signingInput}.${sig}`)).toBeNull();
    expect(verifyBackendJwtClaims(makeToken({ sub: 'u1', role: 'renter', exp: FUTURE }, 'shared-secret'))?.role).toBe('renter');
  });

  it('decode rejects non-access token types and tokens without a string sub', () => {
    expect(decodeBackendJwtClaims(makeToken({ sub: 'u1', typ: 'handoff', exp: FUTURE }))).toBeNull();
    expect(decodeBackendJwtClaims(makeToken({ exp: FUTURE }))).toBeNull();
    expect(decodeBackendJwtClaims(makeToken({ sub: 'u1', typ: 'access', exp: FUTURE }))?.sub).toBe('u1');
  });
});
