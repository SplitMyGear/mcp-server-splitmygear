import crypto from 'crypto';
import { readBackendJwtClaims } from '../src/lib/jwt';

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
