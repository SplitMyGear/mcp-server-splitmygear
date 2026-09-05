/**
 * Evidence / media uploads: a multipart client for the backend's `POST /upload`
 * (JwtAuthGuard; field `file`, body field `folder` from the controller's
 * allow-list, 10 MB server cap). The MCP accepts base64 content from the model,
 * decodes it, caps it at {@link MAX_UPLOAD_BYTES}, checks the magic bytes match
 * the declared content type (the backend does the same and 400s otherwise, so
 * failing fast here saves a wasted upload) and forwards the bytes with the
 * caller's own JWT. File content is never logged.
 *
 * Folders: evidence folders (`disputes`, `claims`, `incidental-charges`,
 * `inspections`, `insurance`) land on the PRIVATE blob store and are only
 * accepted back by the matching process (a claim only accepts `claims/...`
 * URLs); listing / profile photos stay public.
 */
import { backendBaseUrl } from '@/lib/backend-client';
import type { Result } from './_shared';

export const UPLOAD_FOLDERS = [
  'disputes',
  'claims',
  'incidental-charges',
  'inspections',
  'listings',
  'insurance',
  'profile-photos',
  'general',
] as const;
export type UploadFolder = (typeof UPLOAD_FOLDERS)[number];

/**
 * Content types the backend accepts by MAGIC BYTES (`sniffFileType`: JPEG, PNG,
 * GIF, WebP, PDF). HEIC is deliberately absent: the backend has no signature
 * for it and rejects the bytes with a 400, so offering it would only mislead.
 */
export const UPLOAD_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'] as const;
export type UploadContentType = (typeof UPLOAD_CONTENT_TYPES)[number];

/** Decoded size cap (the backend allows 10 MB; MCP payloads are kept smaller). */
export const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
/** Base64 expands 3 bytes to 4 chars; allow a little slack for padding/newlines. */
export const MAX_BASE64_CHARS = Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 64;

const UPLOAD_TIMEOUT_MS = 20_000;

const EXTENSIONS: Record<UploadContentType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
};

export interface UploadInput {
  folder: UploadFolder;
  contentType: UploadContentType;
  /** Base64 file content (a `data:` URL prefix is tolerated and stripped). */
  base64: string;
  /** Optional original file name; sanitized, extension forced to match contentType. */
  filename?: string;
}

export interface UploadedFile {
  url: string;
  key?: string;
  thumbnailUrl?: string;
}

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[offset + i] !== sig[i]) return false;
  return true;
}

/** Content type from the leading bytes (mirrors the backend's `sniffFileType`); null if unrecognised. */
export function sniffContentType(bytes: Uint8Array): UploadContentType | null {
  if (bytes.length < 4) return null;
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return 'application/pdf';
  return null;
}

/**
 * Decode base64 into a fresh `Uint8Array` (backed by a plain ArrayBuffer so it
 * can be handed to `Blob`). Returns an error string for malformed or oversized
 * input; the size is bounded from the encoded length BEFORE allocating.
 */
export function decodeBase64(input: string): { bytes: Uint8Array<ArrayBuffer> } | { error: string } {
  let text = input.trim();
  const comma = text.indexOf(',');
  if (text.startsWith('data:') && comma !== -1) text = text.slice(comma + 1);
  text = text.replace(/\s+/g, '');
  if (!text) return { error: 'base64 content is empty.' };
  if (text.length > MAX_BASE64_CHARS) return { error: `File is too large: the limit is ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.` };
  // Standard or URL-safe alphabet, optional padding.
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) return { error: 'base64 content is malformed.' };
  const decoded = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (decoded.length === 0) return { error: 'base64 content is malformed.' };
  if (decoded.length > MAX_UPLOAD_BYTES) return { error: `File is too large: the limit is ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.` };
  const bytes = new Uint8Array(new ArrayBuffer(decoded.length));
  bytes.set(decoded);
  return { bytes };
}

/** A storage-safe file name whose extension always matches the content type. */
export function safeFilename(filename: string | undefined, contentType: UploadContentType): string {
  const ext = EXTENSIONS[contentType];
  const rawBase = (filename ?? '').split(/[\\/]/).pop() ?? '';
  const base = rawBase
    .replace(/\.[^.]*$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return `${base || 'upload'}.${ext}`;
}

/** Same error-shape parsing as the JSON client (`{ statusCode, error, message }`). */
function errorMessageFrom(parsed: unknown, status: number): string {
  if (parsed && typeof parsed === 'object') {
    const body = parsed as { message?: unknown; error?: unknown };
    if (Array.isArray(body.message)) {
      const joined = body.message.filter((m): m is string => typeof m === 'string').join('; ');
      if (joined) return joined;
    }
    if (typeof body.message === 'string') return body.message;
    if (typeof body.error === 'string') return body.error;
  }
  return `Upload failed (${status})`;
}

export const filesApi = {
  /** POST /upload (multipart): returns the stored file URL. */
  async uploadFile(token: string, input: UploadInput): Promise<Result<UploadedFile>> {
    if (!(UPLOAD_FOLDERS as readonly string[]).includes(input.folder)) return { ok: false, error: 'Unknown upload folder.' };
    if (!(UPLOAD_CONTENT_TYPES as readonly string[]).includes(input.contentType)) return { ok: false, error: 'Unsupported content type.' };

    const decoded = decodeBase64(input.base64);
    if ('error' in decoded) return { ok: false, error: decoded.error };
    const sniffed = sniffContentType(decoded.bytes);
    if (sniffed !== input.contentType) {
      return {
        ok: false,
        error: sniffed
          ? `The file content is ${sniffed}, not ${input.contentType}. Pass the matching contentType.`
          : 'The file content is not a recognised JPEG, PNG, WebP, GIF or PDF.',
      };
    }

    const form = new FormData();
    form.append('folder', input.folder);
    form.append('file', new Blob([decoded.bytes], { type: input.contentType }), safeFilename(input.filename, input.contentType));

    let response: Response;
    try {
      response = await fetch(`${backendBaseUrl()}/upload`, {
        method: 'POST',
        // No Content-Type: fetch sets the multipart boundary itself.
        headers: { Authorization: `Bearer ${token}` },
        body: form,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return isTimeout
        ? { ok: false, error: 'Upload timed out talking to Splitt', status: 504 }
        : { ok: false, error: 'Upload failed (network error)', status: 502 };
    }

    const raw = await response.text();
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!response.ok) return { ok: false, error: errorMessageFrom(parsed, response.status), status: response.status };

    const body = (parsed ?? {}) as { url?: unknown; key?: unknown; thumbnailUrl?: unknown };
    if (typeof body.url !== 'string' || !body.url) return { ok: false, error: 'Upload succeeded but Splitt returned no file URL.' };
    const data: UploadedFile = { url: body.url };
    if (typeof body.key === 'string') data.key = body.key;
    if (typeof body.thumbnailUrl === 'string') data.thumbnailUrl = body.thumbnailUrl;
    return { ok: true, data };
  },
};
