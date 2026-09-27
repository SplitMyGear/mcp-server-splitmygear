/** Contract tests for the booking-verification tool backend: method/path/body/token per call, multipart photo uploads, and the tool defs. */
export {};

const mockBackendRequest = jest.fn();
jest.mock('../src/lib/backend-client', () => {
  class BackendApiError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.name = 'BackendApiError'; this.status = status; }
  }
  return {
    BackendApiError,
    backendRequest: (...args: unknown[]) => mockBackendRequest(...args),
    backendBaseUrl: () => 'https://api.test/api/v1',
  };
});

import {
  bookingVerificationTools,
  decodePhoto,
  decodePhotos,
  postMultipart,
  sniffPhotoType,
  MAX_BATCH_BYTES,
  MAX_PHOTO_BYTES,
  MAX_PHOTOS_PER_UPLOAD,
} from '../src/tools/booking-verification';
import { bookingVerificationTools as defs, uploadHandoffPhotos, verifyHandoffToken } from '../src/tools/defs/booking-verification';
import { TOOL_SCOPES } from '../src/tools/registry';

const T = 'h.p.s';
const B = '11111111-1111-4111-8111-111111111111';
const { BackendApiError } = jest.requireMock('../src/lib/backend-client');

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WEBP'), Buffer.alloc(64, 3)]);
const jpegB64 = JPEG.toString('base64');

const mockFetch = jest.fn();

function lastCall() {
  const c = mockBackendRequest.mock.calls[mockBackendRequest.mock.calls.length - 1];
  return { method: c[0], path: c[1], opts: c[2] ?? {} };
}

function fetchResponse(ok: boolean, status: number, body: unknown) {
  return { ok, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}

beforeEach(() => {
  mockBackendRequest.mockReset();
  mockBackendRequest.mockResolvedValue({ ok: 1 });
  mockFetch.mockReset();
  (global as unknown as { fetch: jest.Mock }).fetch = mockFetch;
});

describe('bookingVerificationTools (JSON routes)', () => {
  it('reads verifications, the checklist template and the completion signal with the caller token', async () => {
    await bookingVerificationTools.getVerifications(T, B);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/booking-verification/${B}`, opts: { token: T } });
    expect(lastCall().opts.body).toBeUndefined();
    await bookingVerificationTools.getChecklistTemplate(T, B);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/booking-verification/${B}/checklist-template`, opts: { token: T } });
    await bookingVerificationTools.getInspectionCompletion(T, B);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/booking-verification/${B}/inspection-completion`, opts: { token: T } });
  });

  it('submits the checklist with only DTO fields (per item too) and drops undefined values', async () => {
    await bookingVerificationTools.submitChecklist(T, B, {
      type: 'PICKUP',
      checklist: [
        { label: 'Fuel level', value: 'half', ok: undefined, note: undefined, photoUrl: undefined },
        { label: 'Visible damage', ok: true, note: 'none', photoUrl: 'https://blob.example/x.jpg' },
      ],
      complete: undefined,
    });
    expect(lastCall()).toMatchObject({ method: 'POST', path: `/booking-verification/${B}/checklist`, opts: { token: T } });
    expect(lastCall().opts.body).toEqual({
      type: 'PICKUP',
      checklist: [
        { label: 'Fuel level', value: 'half' },
        { label: 'Visible damage', ok: true, note: 'none', photoUrl: 'https://blob.example/x.jpg' },
      ],
    });
    await bookingVerificationTools.submitChecklist(T, B, { type: 'RETURN', checklist: [{ label: 'Overall condition', value: 'good' }], complete: true });
    expect(lastCall().opts.body).toEqual({ type: 'RETURN', checklist: [{ label: 'Overall condition', value: 'good' }], complete: true });
  });

  it('mints and redeems handoff tokens', async () => {
    await bookingVerificationTools.createHandoffToken(T, B, 'RETURN');
    expect(lastCall()).toMatchObject({ method: 'POST', path: `/booking-verification/${B}/handoff-token`, opts: { token: T, body: { type: 'RETURN' } } });
    await bookingVerificationTools.verifyHandoffToken(T, 'eyJ.handoff.sig');
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/booking-verification/handoff-verify', opts: { token: T, body: { token: 'eyJ.handoff.sig' } } });
  });

  it('returns an error Result when the backend rejects the call', async () => {
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(403, 'You are not authorized to view these verifications'));
    expect(await bookingVerificationTools.getVerifications(T, B)).toEqual({ ok: false, error: 'You are not authorized to view these verifications', status: 403 });
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(400, 'Invalid or expired handoff token'));
    expect(await bookingVerificationTools.verifyHandoffToken(T, 'stale')).toEqual({ ok: false, error: 'Invalid or expired handoff token', status: 400 });
  });
});

describe('photo decoding', () => {
  it('sniffs JPEG / PNG / WebP and rejects anything else', () => {
    expect(sniffPhotoType(JPEG)).toBe('image/jpeg');
    expect(sniffPhotoType(PNG)).toBe('image/png');
    expect(sniffPhotoType(WEBP)).toBe('image/webp');
    expect(sniffPhotoType(Buffer.from('%PDF-1.4 ....'))).toBeNull();
    expect(sniffPhotoType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffPhotoType(Buffer.from([0xff, 0xd8]))).toBeNull();
  });

  it('decodes plain and data-URL base64, sanitises the filename and forces the extension', () => {
    const plain = decodePhoto({ base64: jpegB64 }, 0);
    expect(plain.ok).toBe(true);
    if (plain.ok) {
      expect(plain.photo.contentType).toBe('image/jpeg');
      expect(plain.photo.filename).toBe('photo-1.jpg');
      expect(Buffer.from(plain.photo.bytes).equals(JPEG)).toBe(true);
    }
    const dataUrl = decodePhoto({ base64: `data:image/png;base64,${PNG.toString('base64')}`, filename: '../../etc/passwd.svg' }, 2);
    expect(dataUrl.ok).toBe(true);
    if (dataUrl.ok) {
      expect(dataUrl.photo.contentType).toBe('image/png');
      expect(dataUrl.photo.filename).toBe('passwd.png');
    }
    const spaced = decodePhoto({ base64: WEBP.toString('base64').replace(/(.{20})/g, '$1\n'), filename: 'Front Left (1).jpeg', contentType: 'image/webp' }, 0);
    expect(spaced.ok).toBe(true);
    if (spaced.ok) expect(spaced.photo.filename).toBe('Front-Left-1.webp');
  });

  it('rejects empty, malformed, oversized, non-image and mismatched photos with a per-photo message', () => {
    expect(decodePhoto({ base64: '   ' }, 0)).toEqual({ ok: false, error: expect.stringMatching(/^Photo 1: .*empty/) });
    expect(decodePhoto({ base64: 'data:image/png,notbase64' }, 0)).toEqual({ ok: false, error: expect.stringMatching(/must be base64/) });
    expect(decodePhoto({ base64: '!!!!' }, 1)).toEqual({ ok: false, error: expect.stringMatching(/^Photo 2: .*not valid base64/) });
    expect(decodePhoto({ base64: 'A'.repeat(MAX_PHOTO_BYTES * 2) }, 0)).toEqual({ ok: false, error: expect.stringMatching(/too large/) });
    const justOver = Buffer.concat([JPEG, Buffer.alloc(MAX_PHOTO_BYTES - JPEG.length + 1)]).toString('base64');
    expect(decodePhoto({ base64: justOver }, 0)).toEqual({ ok: false, error: expect.stringMatching(/too large/) });
    expect(decodePhoto({ base64: Buffer.from('%PDF-1.4 not an image at all').toString('base64') }, 0)).toEqual({
      ok: false,
      error: expect.stringMatching(/not a JPEG, PNG or WebP/),
    });
    expect(decodePhoto({ base64: jpegB64, contentType: 'image/png' }, 0)).toEqual({ ok: false, error: expect.stringMatching(/does not match/) });
  });

  it('decodes a batch and enforces the count bounds', () => {
    expect(decodePhotos([])).toEqual({ ok: false, error: 'Pass at least one photo.' });
    expect(decodePhotos(new Array(MAX_PHOTOS_PER_UPLOAD + 1).fill({ base64: jpegB64 }))).toEqual({ ok: false, error: expect.stringMatching(/At most 10/) });
    const bad = decodePhotos([{ base64: jpegB64 }, { base64: 'AAAA' }]);
    expect(bad).toEqual({ ok: false, error: expect.stringMatching(/^Photo 2/) });
    const good = decodePhotos([{ base64: jpegB64 }, { base64: PNG.toString('base64') }]);
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.photos.map((p) => p.contentType)).toEqual(['image/jpeg', 'image/png']);
    // Two photos that each fit the per-photo cap but together exceed the per-call total.
    const big = Buffer.concat([JPEG, Buffer.alloc(Math.ceil(MAX_BATCH_BYTES / 2))]).toString('base64');
    expect(decodePhotos([{ base64: big }, { base64: big }])).toEqual({ ok: false, error: expect.stringMatching(/Too much image data in one call/) });
  });
});

describe('multipart uploads', () => {
  const decodedTwo = () => {
    const r = decodePhotos([{ base64: jpegB64, filename: 'front.jpg' }, { base64: PNG.toString('base64') }]);
    if (!r.ok) throw new Error(r.error);
    return r.photos;
  };

  it('posts pickup/return photos as multipart "files" with the Bearer token and no manual Content-Type', async () => {
    mockFetch.mockResolvedValue(fetchResponse(true, 201, { id: 'v1', type: 'PICKUP', status: 'VERIFIED', imageKeys: ['k1', 'k2'] }));
    const res = await bookingVerificationTools.uploadHandoffPhotos(T, B, 'PICKUP', decodedTwo());
    expect(res).toEqual({ ok: true, data: { id: 'v1', type: 'PICKUP', status: 'VERIFIED', imageKeys: ['k1', 'k2'] } });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`https://api.test/api/v1/booking-verification/${B}/pickup`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: `Bearer ${T}` });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body).toBeInstanceOf(FormData);
    const files = (init.body as FormData).getAll('files') as File[];
    expect(files).toHaveLength(2);
    expect(files.map((f) => [f.name, f.type, f.size])).toEqual([['front.jpg', 'image/jpeg', JPEG.length], ['photo-2.png', 'image/png', PNG.length]]);
    expect(Buffer.from(await files[0].arrayBuffer()).equals(JPEG)).toBe(true);
    expect([...(init.body as FormData).keys()]).toEqual(['files', 'files']);

    await bookingVerificationTools.uploadHandoffPhotos(T, B, 'RETURN', decodedTwo().slice(0, 1));
    expect(mockFetch.mock.calls[1][0]).toBe(`https://api.test/api/v1/booking-verification/${B}/return`);
  });

  it('maps backend error shapes, network failures and timeouts to Results', async () => {
    mockFetch.mockResolvedValueOnce(fetchResponse(false, 400, { statusCode: 400, message: ['File content does not match an allowed image or PDF type'] }));
    expect(await postMultipart('/x', T, new FormData())).toEqual({ ok: false, error: 'File content does not match an allowed image or PDF type', status: 400 });
    mockFetch.mockResolvedValueOnce(fetchResponse(false, 403, { message: 'Not authorized to verify this booking' }));
    expect(await postMultipart('/x', T, new FormData())).toMatchObject({ ok: false, status: 403, error: 'Not authorized to verify this booking' });
    mockFetch.mockResolvedValueOnce(fetchResponse(false, 413, { error: 'Payload Too Large' }));
    expect(await postMultipart('/x', T, new FormData())).toMatchObject({ ok: false, status: 413, error: 'Payload Too Large' });
    mockFetch.mockResolvedValueOnce(fetchResponse(false, 502, '<html>bad gateway</html>'));
    expect(await postMultipart('/x', T, new FormData())).toEqual({ ok: false, error: 'Upload failed (502)', status: 502 });
    mockFetch.mockResolvedValueOnce(fetchResponse(true, 200, ''));
    expect(await postMultipart('/x', T, new FormData())).toEqual({ ok: true, data: undefined });
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await postMultipart('/x', T, new FormData())).toMatchObject({ ok: false, status: 502, error: expect.stringMatching(/network/) });
    const timeout = new Error('aborted');
    timeout.name = 'TimeoutError';
    mockFetch.mockRejectedValueOnce(timeout);
    expect(await postMultipart('/x', T, new FormData())).toMatchObject({ ok: false, status: 504, error: expect.stringMatching(/timed out/) });
  });
});

describe('bookingVerificationTools defs', () => {
  const ctx = { userId: 'u', role: 'renter', token: T, kind: 'oauth' as const };

  it('exports seven documented tools, all user access in the bookings scope, with no em-dashes', () => {
    expect(defs.map((t) => t.name)).toEqual([
      'get_booking_verification',
      'get_inspection_checklist_template',
      'get_inspection_completion',
      'submit_inspection_checklist',
      'upload_handoff_photos',
      'create_handoff_token',
      'verify_handoff_token',
    ]);
    for (const t of defs) {
      expect(t.access).toBe('user');
      expect(t.scope).toBe('bookings');
      expect(TOOL_SCOPES).toContain(t.scope);
      expect(t.title.length).toBeGreaterThan(2);
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.description).not.toMatch(/—/);
      expect(t.annotations).toHaveProperty('readOnlyHint');
      expect(typeof t.handler).toBe('function');
    }
    expect(defs.filter((t) => t.annotations.readOnlyHint).map((t) => t.name)).toEqual([
      'get_booking_verification',
      'get_inspection_checklist_template',
      'get_inspection_completion',
    ]);
    expect(defs.every((t) => !t.annotations.destructiveHint)).toBe(true);
  });

  it('upload_handoff_photos rejects bad photos before touching the backend and summarises the row on success', async () => {
    const bad = await uploadHandoffPhotos.handler({ bookingId: B, type: 'PICKUP', photos: [{ base64: 'AAAA' }] }, ctx);
    expect(bad.isError).toBe(true);
    expect(bad.content[0]).toMatchObject({ type: 'text', text: expect.stringMatching(/Photo 1/) });
    expect(mockFetch).not.toHaveBeenCalled();

    mockFetch.mockResolvedValue(
      fetchResponse(true, 201, { id: 'v1', bookingId: B, type: 'PICKUP', status: 'VERIFIED', isAuthentic: true, imageKeys: ['a', 'b', 'c'], exifMetadata: [{ huge: 'dump' }], imageMeta: { a: {} } }),
    );
    const res = await uploadHandoffPhotos.handler({ bookingId: B, type: 'PICKUP', photos: [{ base64: jpegB64 }] }, ctx);
    expect(res.isError).toBeUndefined();
    const out = JSON.parse((res.content[0] as { text: string }).text);
    expect(out).toMatchObject({ verificationId: 'v1', type: 'PICKUP', status: 'VERIFIED', isAuthentic: true, totalPhotos: 3, photosUploadedNow: 1 });
    expect(out).not.toHaveProperty('exifMetadata');
    expect(out).not.toHaveProperty('imageKeys');
  });

  it('upload_handoff_photos surfaces a backend rejection with the status hint', async () => {
    mockFetch.mockResolvedValueOnce(fetchResponse(false, 403, { message: 'Not authorized to verify this booking' }));
    const denied = await uploadHandoffPhotos.handler({ bookingId: B, type: 'RETURN', photos: [{ base64: jpegB64 }] }, ctx);
    expect(denied.isError).toBe(true);
    expect((denied.content[0] as { text: string }).text).toMatch(/Not allowed for this account: Not authorized to verify this booking/);
  });

  it('verify_handoff_token forwards the scanned token under the caller JWT', async () => {
    mockBackendRequest.mockResolvedValueOnce({ success: true, bookingId: B, type: 'PICKUP', message: 'Pickup verified cryptographically.' });
    const res = await verifyHandoffToken.handler({ token: 'eyJhbGciOiJIUzI1NiJ9.handoff.signature' }, ctx);
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/booking-verification/handoff-verify', opts: { token: T, body: { token: 'eyJhbGciOiJIUzI1NiJ9.handoff.signature' } } });
    expect(JSON.parse((res.content[0] as { text: string }).text)).toMatchObject({ success: true, type: 'PICKUP' });
  });
});
