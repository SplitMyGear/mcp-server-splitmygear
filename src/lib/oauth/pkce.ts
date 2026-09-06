/**
 * PKCE (RFC 7636), S256 only — `plain` is forbidden by OAuth 2.1 and the MCP
 * authorization spec. A verifier is 43–128 unreserved characters.
 */
import crypto from 'crypto';

const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function isValidCodeVerifier(verifier: unknown): verifier is string {
  return typeof verifier === 'string' && VERIFIER_RE.test(verifier);
}

/** A challenge is the base64url SHA-256 of a verifier: always exactly 43 chars. */
export function isValidCodeChallenge(challenge: unknown): challenge is string {
  return typeof challenge === 'string' && /^[A-Za-z0-9\-_]{43}$/.test(challenge);
}

export function s256Challenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function verifyS256(verifier: string, expectedChallenge: string): boolean {
  if (!isValidCodeVerifier(verifier) || !isValidCodeChallenge(expectedChallenge)) return false;
  const actual = Buffer.from(s256Challenge(verifier));
  const expected = Buffer.from(expectedChallenge);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
