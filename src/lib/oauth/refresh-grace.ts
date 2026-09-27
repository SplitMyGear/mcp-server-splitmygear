/**
 * Refresh-token rotation grace.
 *
 * Every refresh rotates: the backend revokes the refresh token it was given
 * and mints a new pair (`POST /auth/refresh`). That is what OAuth 2.1 asks of
 * a public client, but it makes one refresh request unrepeatable. If the
 * client never sees the answer (a dropped connection, its own timeout) and
 * retries, or two of its requests refresh the same token one after the other,
 * the second one presents a token the backend has already revoked, gets
 * `invalid_grant`, and the user is told to reconnect the app for no reason.
 *
 * So for a short window (`REFRESH_GRACE_S`) after a successful rotation, the
 * SAME refresh token presented again, by the same client and with the same
 * requested scope, gets the SAME answer instead of a second backend call.
 * RFC 9700 §4.14.2 allows this; hosted identity providers call it a rotation
 * overlap period. It gives nothing to someone who does not already hold the
 * refresh token, and whoever holds it could have refreshed with it anyway
 * until the moment it was used.
 *
 * Where the answer is kept:
 *  - in this instance's memory, and while a rotation is still in flight a
 *    concurrent caller on the same instance waits for it instead of calling
 *    the backend a second time;
 *  - in the shared store when one is configured, so a retry that lands on
 *    another serverless instance is answered too. The store holds only
 *    ciphertext: AES-256-GCM under a key derived from the PRESENTED refresh
 *    token together with the server's own secret, stored under an HMAC of the
 *    token. Reading the store is not enough to recover a token; it takes the
 *    old refresh token as well as MCP_OAUTH_SIGNING_KEY.
 *
 * Only successes are kept. A failure is answered normally and leaves nothing
 * behind, so a client retrying after a real failure is not locked out.
 */
import crypto from 'crypto';
import { deriveKey } from './config';
import { getValue, putValue, sharedStoreEnabled } from '@/lib/shared-store';
import type { OAuthTokenResponse } from './tokens';

/** How long a just-rotated refresh token may be presented again for the same answer. */
export const REFRESH_GRACE_S = 60;
const MAX_LOCAL_ENTRIES = 2_000;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** What a rotation produced: tokens, or the OAuth error to answer with. */
export type RotationOutcome =
  | { ok: true; tokens: OAuthTokenResponse }
  | { ok: false; error: { code: 'invalid_grant' | 'server_error' | 'temporarily_unavailable'; description: string; status: number } };

interface Kept {
  tokens: OAuthTokenResponse;
  /** Unix ms at which the tokens were issued (expires_in is re-based on it). */
  issuedAt: number;
}

const recent = new Map<string, Kept>();
const inFlight = new Map<string, Promise<RotationOutcome>>();

function graceId(refreshToken: string, scope: string): string {
  return crypto.createHmac('sha256', deriveKey('refresh-grace:id')).update(`${scope}\n${refreshToken}`).digest('base64url');
}

function cipherKey(refreshToken: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', refreshToken, deriveKey('refresh-grace:key'), 'splitt-mcp refresh grace v1', 32));
}

function seal(refreshToken: string, kept: Kept): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', cipherKey(refreshToken), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(kept), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url');
}

function unseal(refreshToken: string, blob: string): Kept | null {
  try {
    const raw = Buffer.from(blob, 'base64url');
    if (raw.length < IV_BYTES + TAG_BYTES + 1) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', cipherKey(refreshToken), raw.subarray(0, IV_BYTES));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    const text = Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]).toString('utf8');
    const kept = JSON.parse(text) as Partial<Kept>;
    if (!kept || typeof kept.issuedAt !== 'number' || !kept.tokens || typeof kept.tokens.access_token !== 'string') return null;
    return kept as Kept;
  } catch {
    return null;
  }
}

/** The kept answer with `expires_in` counted from its original issue time. */
function replay(kept: Kept, now: number): OAuthTokenResponse | null {
  if (now - kept.issuedAt > REFRESH_GRACE_S * 1000) return null;
  const elapsed = Math.floor((now - kept.issuedAt) / 1000);
  return { ...kept.tokens, expires_in: Math.max(1, kept.tokens.expires_in - elapsed) };
}

function keepLocally(id: string, kept: Kept, now: number): void {
  if (recent.size >= MAX_LOCAL_ENTRIES) {
    for (const [key, value] of recent) if (now - value.issuedAt > REFRESH_GRACE_S * 1000) recent.delete(key);
    // Still full of live entries: drop the oldest rather than grow without bound.
    if (recent.size >= MAX_LOCAL_ENTRIES) {
      const oldest = recent.keys().next().value;
      if (oldest !== undefined) recent.delete(oldest);
    }
  }
  recent.set(id, kept);
}

/**
 * Run `rotate` for this refresh token at most once per grace window: a repeat
 * within the window gets the kept answer, a concurrent repeat on this
 * instance waits for the rotation already under way.
 */
export async function withRefreshGrace(
  refreshToken: string,
  scope: string | undefined,
  rotate: () => Promise<RotationOutcome>,
): Promise<RotationOutcome> {
  const id = graceId(refreshToken, scope ?? '');
  const now = Date.now();

  const local = recent.get(id);
  if (local) {
    const tokens = replay(local, now);
    if (tokens) return { ok: true, tokens };
    recent.delete(id);
  }

  const pending = inFlight.get(id);
  if (pending) return pending;

  const run = (async (): Promise<RotationOutcome> => {
    if (sharedStoreEnabled()) {
      const blob = await getValue(`rtg:${id}`);
      const kept = typeof blob === 'string' ? unseal(refreshToken, blob) : null;
      const tokens = kept ? replay(kept, Date.now()) : null;
      if (kept && tokens) {
        keepLocally(id, kept, Date.now());
        return { ok: true, tokens };
      }
    }
    const outcome = await rotate();
    if (outcome.ok) {
      const kept: Kept = { tokens: outcome.tokens, issuedAt: Date.now() };
      keepLocally(id, kept, kept.issuedAt);
      if (sharedStoreEnabled()) await putValue(`rtg:${id}`, seal(refreshToken, kept), REFRESH_GRACE_S);
    }
    return outcome;
  })();

  inFlight.set(id, run);
  try {
    return await run;
  } finally {
    inFlight.delete(id);
  }
}

/** Test hook: forget every kept answer and in-flight rotation. */
export function _resetRefreshGraceForTests(): void {
  recent.clear();
  inFlight.clear();
}
