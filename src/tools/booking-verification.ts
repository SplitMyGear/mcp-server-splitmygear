/**
 * Booking handoff verification: pickup/return condition photos, the structured
 * inspection checklist, and the QR/NFC handoff token, for BOTH parties of a
 * rental booking (the backend's `assertBookingParty` decides who may act; the
 * MCP only ever forwards the signed-in user's own JWT).
 *
 * Thin clients of `/booking-verification/*`. The two photo routes take
 * multipart (`FilesInterceptor('files', 10)`), which the shared JSON
 * `backendRequest` cannot send, so this module builds a `FormData` body with
 * the global `fetch` instead. Photos arrive from the model as base64, are
 * decoded and bounded here (3 MB each, JPEG/PNG/WebP only, sniffed by magic
 * bytes exactly like the backend's `sniffFileType`), and their bytes are never
 * logged.
 */
import { backendBaseUrl } from '@/lib/backend-client';
import { call, compact, type Result } from './_shared';

export type HandoffType = 'PICKUP' | 'RETURN';
export const HANDOFF_TYPES = ['PICKUP', 'RETURN'] as const;

/** Image types the backend's magic-byte sniffer accepts on these routes (no HEIC, no SVG, no PDF). */
export const PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type PhotoMime = (typeof PHOTO_MIME_TYPES)[number];

/** 3 MB decoded, per photo (the backend allows 10 MB; we keep MCP payloads small). */
export const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
/** Mirrors the backend `FilesInterceptor('files', 10)` bound. */
export const MAX_PHOTOS_PER_UPLOAD = 10;
/**
 * Total decoded bytes per call. The MCP request itself is a JSON-RPC body on a
 * serverless function with a ~4.5 MB request cap, so one call can carry about
 * 3 MB of images (4 MB of base64) in total; further photos go in another call
 * (the backend appends to the same stage).
 */
export const MAX_BATCH_BYTES = 3 * 1024 * 1024;
/** Base64 characters needed for MAX_PHOTO_BYTES, plus room for a data: prefix and whitespace. */
export const MAX_PHOTO_BASE64_CHARS = Math.ceil(MAX_PHOTO_BYTES / 3) * 4 + 4096;

const UPLOAD_TIMEOUT_MS = 20_000;

export interface ChecklistItemInput {
  label: string;
  value?: string;
  ok?: boolean;
  note?: string;
  photoUrl?: string;
}

export interface PhotoInput {
  /** Base64 image bytes; a `data:image/...;base64,` prefix is tolerated and stripped. */
  base64: string;
  /** Optional file name; sanitised, and its extension is forced to match the sniffed type. */
  filename?: string;
  /** Optional declared type; when given it must agree with the sniffed magic bytes. */
  contentType?: PhotoMime;
}

export interface DecodedPhoto {
  bytes: Uint8Array;
  contentType: PhotoMime;
  filename: string;
}

const EXTENSION: Record<PhotoMime, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function startsWith(buf: Uint8Array, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

/** Detect JPEG / PNG / WebP by magic bytes (the same signatures the backend checks). */
export function sniffPhotoType(buf: Uint8Array): PhotoMime | null {
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

function safeFilename(raw: string | undefined, index: number, type: PhotoMime): string {
  const ext = EXTENSION[type];
  const base = (raw ?? '')
    .split(/[\\/]/)
    .pop()!
    .replace(/\.[A-Za-z0-9]+$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80);
  return `${base || `photo-${index + 1}`}.${ext}`;
}

/**
 * Decode and validate one base64 photo. Returns a human-readable error (which
 * photo, what is wrong) instead of throwing so the tool can surface it as an
 * `isError` result without ever touching the backend.
 */
export function decodePhoto(photo: PhotoInput, index: number): { ok: true; photo: DecodedPhoto } | { ok: false; error: string } {
  const label = `Photo ${index + 1}`;
  let b64 = (photo.base64 ?? '').trim();
  const dataUrl = /^data:([^;,]*)(;[^,]*)?,/i.exec(b64);
  if (dataUrl) {
    if (!/;base64$/i.test(dataUrl[2] ?? '')) return { ok: false, error: `${label}: data URLs must be base64-encoded.` };
    b64 = b64.slice(dataUrl[0].length);
  }
  b64 = b64.replace(/\s+/g, '');
  if (!b64) return { ok: false, error: `${label}: base64 content is empty.` };
  if (b64.length > MAX_PHOTO_BASE64_CHARS) return { ok: false, error: `${label} is too large: each photo must be at most ${MAX_PHOTO_BYTES / (1024 * 1024)} MB after decoding.` };
  if (!BASE64_RE.test(b64) || b64.length % 4 === 1) return { ok: false, error: `${label}: content is not valid base64.` };

  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length === 0) return { ok: false, error: `${label}: content is not valid base64.` };
  if (bytes.length > MAX_PHOTO_BYTES) return { ok: false, error: `${label} is too large: each photo must be at most ${MAX_PHOTO_BYTES / (1024 * 1024)} MB after decoding.` };

  const sniffed = sniffPhotoType(bytes);
  if (!sniffed) return { ok: false, error: `${label} is not a JPEG, PNG or WebP image (convert HEIC/other formats to JPEG first).` };
  if (photo.contentType && photo.contentType !== sniffed) {
    return { ok: false, error: `${label}: declared contentType ${photo.contentType} does not match the image content (${sniffed}).` };
  }

  return { ok: true, photo: { bytes, contentType: sniffed, filename: safeFilename(photo.filename, index, sniffed) } };
}

/** Decode a whole batch; stops at the first bad photo. */
export function decodePhotos(photos: PhotoInput[]): { ok: true; photos: DecodedPhoto[] } | { ok: false; error: string } {
  if (!Array.isArray(photos) || photos.length === 0) return { ok: false, error: 'Pass at least one photo.' };
  if (photos.length > MAX_PHOTOS_PER_UPLOAD) return { ok: false, error: `At most ${MAX_PHOTOS_PER_UPLOAD} photos per upload.` };
  const decoded: DecodedPhoto[] = [];
  let total = 0;
  for (let i = 0; i < photos.length; i++) {
    const r = decodePhoto(photos[i], i);
    if (!r.ok) return r;
    total += r.photo.bytes.byteLength;
    if (total > MAX_BATCH_BYTES) {
      return { ok: false, error: `Too much image data in one call (max ${MAX_BATCH_BYTES / (1024 * 1024)} MB total after decoding). Upload fewer or smaller photos per call; further calls append to the same stage.` };
    }
    decoded.push(r.photo);
  }
  return { ok: true, photos: decoded };
}

/** Same error-shape parsing as `backend-client.ts` (`{ statusCode, error, message: string | string[] }`). */
function extractErrorMessage(parsed: unknown, status: number): string {
  if (parsed && typeof parsed === 'object') {
    const body = parsed as { message?: unknown; error?: unknown };
    if (Array.isArray(body.message)) {
      return body.message.filter((m) => typeof m === 'string').join('; ') || `Upload failed (${status})`;
    }
    if (typeof body.message === 'string') return body.message;
    if (typeof body.error === 'string') return body.error;
  }
  return `Upload failed (${status})`;
}

function toBlob(photo: DecodedPhoto): Blob {
  // Copy into a plain ArrayBuffer-backed view so the Blob never aliases a pooled Buffer slice.
  const copy = new Uint8Array(photo.bytes.byteLength);
  copy.set(photo.bytes);
  return new Blob([copy], { type: photo.contentType });
}

/**
 * POST a multipart body with the caller's JWT. `fetch` sets the multipart
 * boundary itself, so no Content-Type header is passed. Never logs the body.
 */
export async function postMultipart<T = unknown>(path: string, token: string, form: FormData): Promise<Result<T>> {
  let response: Response;
  try {
    response = await fetch(`${backendBaseUrl()}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return isTimeout
      ? { ok: false, error: 'Upload to Splitt timed out; try fewer or smaller photos.', status: 504 }
      : { ok: false, error: 'Upload to Splitt failed (network error).', status: 502 };
  }
  const raw = await response.text();
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!response.ok) return { ok: false, error: extractErrorMessage(parsed, response.status), status: response.status };
  return { ok: true, data: parsed as T };
}

export const bookingVerificationTools = {
  /** Both stages' verification rows (photos as short-lived signed URLs, checklist, readings, status). */
  getVerifications(token: string, bookingId: string) {
    return call<unknown[]>('GET', `/booking-verification/${bookingId}`, { token });
  },

  /** Starter checklist for the booking's listing category, with server-owned required/requiresPhoto flags. */
  getChecklistTemplate(token: string, bookingId: string) {
    return call<{ category: string | null; items: unknown[] }>('GET', `/booking-verification/${bookingId}/checklist-template`, { token });
  },

  /** Save (complete=false) or finalise (complete=true) the inspection checklist for one stage. Only DTO fields are sent. */
  submitChecklist(token: string, bookingId: string, input: { type: HandoffType; checklist: ChecklistItemInput[]; complete?: boolean }) {
    const body = compact({
      type: input.type,
      checklist: input.checklist.map((item) => compact({ label: item.label, value: item.value, ok: item.ok, note: item.note, photoUrl: item.photoUrl })),
      complete: input.complete,
    });
    return call('POST', `/booking-verification/${bookingId}/checklist`, { token, body });
  },

  /** { departureCompleted, returnCompleted, requiredInspectionMissing }. */
  getInspectionCompletion(token: string, bookingId: string) {
    return call<{ departureCompleted: boolean; returnCompleted: boolean; requiredInspectionMissing: boolean }>(
      'GET',
      `/booking-verification/${bookingId}/inspection-completion`,
      { token },
    );
  },

  /** Mint a 15-minute handoff token (signed JWT, typ=handoff) for the other party to scan. */
  createHandoffToken(token: string, bookingId: string, type: HandoffType) {
    return call<{ token: string }>('POST', `/booking-verification/${bookingId}/handoff-token`, { token, body: { type } });
  },

  /** Redeem a token scanned from the counterparty; flips the booking to PICKUP/RETURN_VERIFIED and records the scan. */
  verifyHandoffToken(token: string, handoffToken: string) {
    return call<{ success: boolean; bookingId: string; type: HandoffType; message: string }>('POST', '/booking-verification/handoff-verify', {
      token,
      body: { token: handoffToken },
    });
  },

  /** Multipart upload of 1..10 already-decoded condition photos to the pickup or return stage. */
  uploadHandoffPhotos(token: string, bookingId: string, type: HandoffType, photos: DecodedPhoto[]) {
    const form = new FormData();
    for (const photo of photos) form.append('files', toBlob(photo), photo.filename);
    return postMultipart(`/booking-verification/${bookingId}/${type.toLowerCase()}`, token, form);
  },
};
