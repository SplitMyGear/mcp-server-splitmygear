/**
 * Sealed, self-describing envelopes — the storage-free primitive behind every
 * OAuth artifact this server issues.
 *
 *   <prefix>.<base64url(iv || ciphertext || gcmTag)>
 *
 * - AES-256-GCM with a per-purpose key (`deriveKey`) and the prefix as
 *   additional authenticated data, so a token of one kind can never be opened
 *   as another kind even with the same key.
 * - Every payload carries `exp` (unix seconds) and is rejected once expired.
 * - Tampering with a single byte fails GCM authentication → `null`.
 *
 * Nothing here is reversible without the operator secret: the backend JWT and
 * refresh token wrapped inside an access/refresh envelope are opaque to the
 * MCP client that holds them.
 */
import crypto from 'crypto';
import { deriveKey } from './config';

const IV_BYTES = 12;
const TAG_BYTES = 16;

export type EnvelopeKind = 'code' | 'at' | 'rt' | 'req' | 'chal';

/** Wire prefix per kind: makes tokens recognisable in logs/configs without decoding. */
export const ENVELOPE_PREFIX: Record<EnvelopeKind, string> = {
  code: 'smg_ac',
  at: 'smg_at',
  rt: 'smg_rt',
  req: 'smg_rq',
  chal: 'smg_ch',
};

interface BasePayload {
  /** Unix seconds after which the envelope is invalid. */
  exp: number;
  /** Unix seconds at issue. */
  iat: number;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function seal<T extends object>(kind: EnvelopeKind, payload: T & BasePayload): string {
  const key = deriveKey(`envelope:${kind}`);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(ENVELOPE_PREFIX[kind]));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_PREFIX[kind]}.${Buffer.concat([iv, ciphertext, tag]).toString('base64url')}`;
}

/**
 * Open an envelope of the expected kind. Returns `null` for a wrong prefix,
 * bad encoding, failed authentication, malformed payload, or expiry.
 */
export function open<T extends object>(kind: EnvelopeKind, token: string | undefined | null): (T & BasePayload) | null {
  if (!token || typeof token !== 'string') return null;
  const prefix = `${ENVELOPE_PREFIX[kind]}.`;
  if (!token.startsWith(prefix)) return null;
  let raw: Buffer;
  try {
    raw = Buffer.from(token.slice(prefix.length), 'base64url');
  } catch {
    return null;
  }
  if (raw.length < IV_BYTES + TAG_BYTES + 1) return null;
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
  let plaintext: string;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(`envelope:${kind}`), iv);
    decipher.setAAD(Buffer.from(ENVELOPE_PREFIX[kind]));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Partial<BasePayload>;
  if (typeof p.exp !== 'number' || p.exp <= nowSeconds()) return null;
  return payload as T & BasePayload;
}

/** Is this bearer string one of OUR access-token envelopes (vs a raw backend JWT)? */
export function looksLikeAccessEnvelope(token: string): boolean {
  return token.startsWith(`${ENVELOPE_PREFIX.at}.`);
}
