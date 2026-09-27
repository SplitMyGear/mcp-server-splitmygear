/** Contract tests for the upload backend module (multipart POST /upload) and the upload_file tool def. */
import { backendBaseUrl } from '../src/lib/backend-client';
import { filesApi, decodeBase64, sniffContentType, safeFilename, MAX_UPLOAD_BYTES, MAX_BASE64_CHARS, UPLOAD_FOLDERS, UPLOAD_CONTENT_TYPES } from '../src/tools/files';
import { filesTools, uploadFile } from '../src/tools/defs/files';

const T = 'h.p.s';
const mockFetch = jest.fn();

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const GIF = Buffer.from('GIF89a\0\0');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.from([0, 0, 0, 0])]);
const PDF = Buffer.from('%PDF-1.4\n%');
const PNG64 = PNG.toString('base64');

function makeResponse(ok: boolean, status: number, body: unknown) {
  return { ok, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}

function lastRequest() {
  const [url, init] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1] as [string, RequestInit & { headers: Record<string, string>; body: FormData }];
  return { url, init };
}

beforeEach(() => {
  mockFetch.mockReset();
  (global as unknown as { fetch: jest.Mock }).fetch = mockFetch;
  mockFetch.mockResolvedValue(makeResponse(true, 200, { success: true, key: 'claims/abc.png', url: 'https://x.private.blob.vercel-storage.com/claims/abc.png' }));
});

describe('helpers', () => {
  it('sniffs the supported content types and rejects others', () => {
    expect(sniffContentType(PNG)).toBe('image/png');
    expect(sniffContentType(JPEG)).toBe('image/jpeg');
    // GIF is deliberately unsupported: the backend stores it as application/octet-stream.
    expect(sniffContentType(GIF)).toBeNull();
    expect(sniffContentType(WEBP)).toBe('image/webp');
    expect(sniffContentType(PDF)).toBe('application/pdf');
    expect(sniffContentType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffContentType(Buffer.from([1, 2]))).toBeNull();
  });

  it('decodes plain, data-URL and url-safe base64 and bounds the size before allocating', () => {
    const plain = decodeBase64(PNG64);
    expect('bytes' in plain && Buffer.from(plain.bytes).equals(PNG)).toBe(true);
    const dataUrl = decodeBase64(`data:image/png;base64,${PNG64}`);
    expect('bytes' in dataUrl && Buffer.from(dataUrl.bytes).equals(PNG)).toBe(true);
    const urlSafe = decodeBase64(Buffer.from([0xfb, 0xff, 0xbf]).toString('base64url'));
    expect('bytes' in urlSafe && Buffer.from(urlSafe.bytes).equals(Buffer.from([0xfb, 0xff, 0xbf]))).toBe(true);
    expect(decodeBase64('   ')).toEqual({ error: 'base64 content is empty.' });
    expect(decodeBase64('not base64!!')).toEqual({ error: 'base64 content is malformed.' });
    expect(decodeBase64('====')).toEqual({ error: 'base64 content is malformed.' });
    expect(decodeBase64('A'.repeat(MAX_BASE64_CHARS + 1))).toEqual({ error: `File is too large: the limit is ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.` });
    // Just under the encoded cap but over the decoded cap (padding slack) is still rejected.
    const oversized = Buffer.alloc(MAX_UPLOAD_BYTES + 1).toString('base64');
    expect(oversized.length).toBeLessThanOrEqual(MAX_BASE64_CHARS);
    expect(decodeBase64(oversized)).toMatchObject({ error: expect.stringMatching(/too large/) });
    // The decoded bytes are a fresh ArrayBuffer-backed view (Blob-safe).
    expect('bytes' in plain && plain.bytes.buffer.byteLength).toBe(PNG.length);
  });

  it('builds a safe file name whose extension follows the content type', () => {
    expect(safeFilename(undefined, 'image/png')).toBe('upload.png');
    expect(safeFilename('../../etc/passwd', 'application/pdf')).toBe('passwd.pdf');
    expect(safeFilename('C:\\photos\\my broken tent (1).HEIC', 'image/jpeg')).toBe('my-broken-tent-1.jpg');
    expect(safeFilename('evil.svg', 'image/png')).toBe('evil.png');
    expect(safeFilename('x'.repeat(200) + '.png', 'image/png')).toBe('x'.repeat(80) + '.png');
    expect(safeFilename('....', 'image/webp')).toBe('upload.webp');
  });
});

describe('filesApi.uploadFile', () => {
  it('posts multipart to /upload with the folder, a typed file and the bearer token (no JSON content type)', async () => {
    const result = await filesApi.uploadFile(T, { folder: 'claims', contentType: 'image/png', base64: PNG64, filename: 'tent damage.png' });
    expect(result).toEqual({ ok: true, data: { url: 'https://x.private.blob.vercel-storage.com/claims/abc.png', key: 'claims/abc.png' } });
    const { url, init } = lastRequest();
    expect(url).toBe(`${backendBaseUrl()}/upload`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: `Bearer ${T}` });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get('folder')).toBe('claims');
    const file = init.body.get('file') as File;
    expect(file.type).toBe('image/png');
    expect(file.size).toBe(PNG.length);
    expect(file.name).toBe('tent-damage.png');
    expect(Buffer.from(await file.arrayBuffer()).equals(PNG)).toBe(true);
    expect([...init.body.keys()]).toEqual(['folder', 'file']);
  });

  it('accepts every declared folder and content type', async () => {
    const samples: Record<(typeof UPLOAD_CONTENT_TYPES)[number], Buffer> = { 'image/jpeg': JPEG, 'image/png': PNG, 'image/webp': WEBP, 'application/pdf': PDF };
    for (const folder of UPLOAD_FOLDERS) {
      for (const contentType of UPLOAD_CONTENT_TYPES) {
        const result = await filesApi.uploadFile(T, { folder, contentType, base64: samples[contentType].toString('base64') });
        expect(result.ok).toBe(true);
        expect(lastRequest().init.body.get('folder')).toBe(folder);
        expect((lastRequest().init.body.get('file') as File).type).toBe(contentType);
      }
    }
    expect(mockFetch).toHaveBeenCalledTimes(UPLOAD_FOLDERS.length * UPLOAD_CONTENT_TYPES.length);
  });

  it('refuses bad input without calling the backend', async () => {
    expect(await filesApi.uploadFile(T, { folder: 'claims', contentType: 'image/jpeg', base64: PNG64 })).toEqual({
      ok: false,
      error: 'The file content is image/png, not image/jpeg. Pass the matching contentType.',
    });
    expect(await filesApi.uploadFile(T, { folder: 'claims', contentType: 'image/png', base64: Buffer.from('<html>hi</html>').toString('base64') })).toEqual({
      ok: false,
      error: 'The file content is not a recognised JPEG, PNG, WebP or PDF.',
    });
    expect(await filesApi.uploadFile(T, { folder: 'claims', contentType: 'image/png', base64: '***' })).toEqual({ ok: false, error: 'base64 content is malformed.' });
    expect(await filesApi.uploadFile(T, { folder: 'nope' as never, contentType: 'image/png', base64: PNG64 })).toEqual({ ok: false, error: 'Unknown upload folder.' });
    expect(await filesApi.uploadFile(T, { folder: 'claims', contentType: 'image/heic' as never, base64: PNG64 })).toEqual({ ok: false, error: 'Unsupported content type.' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('maps backend errors (string, array and bare error shapes) into a Result with the status', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(false, 400, { statusCode: 400, message: 'Invalid upload folder', error: 'Bad Request' }));
    expect(await filesApi.uploadFile(T, { folder: 'claims', contentType: 'image/png', base64: PNG64 })).toEqual({ ok: false, error: 'Invalid upload folder', status: 400 });
    mockFetch.mockResolvedValueOnce(makeResponse(false, 400, { message: ['a', 'b'] }));
    expect(await filesApi.uploadFile(T, { folder: 'claims', contentType: 'image/png', base64: PNG64 })).toEqual({ ok: false, error: 'a; b', status: 400 });
    mockFetch.mockResolvedValueOnce(makeResponse(false, 403, { error: 'Forbidden' }));
    expect(await filesApi.uploadFile(T, { folder: 'claims', contentType: 'image/png', base64: PNG64 })).toEqual({ ok: false, error: 'Forbidden', status: 403 });
    mockFetch.mockResolvedValueOnce(makeResponse(false, 413, '<html>too big</html>'));
    expect(await filesApi.uploadFile(T, { folder: 'claims', contentType: 'image/png', base64: PNG64 })).toEqual({ ok: false, error: 'Upload failed (413)', status: 413 });
  });

  it('normalizes timeouts and network failures, and a 2xx without a url', async () => {
    mockFetch.mockRejectedValueOnce(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    expect(await filesApi.uploadFile(T, { folder: 'disputes', contentType: 'image/png', base64: PNG64 })).toEqual({ ok: false, error: 'Upload timed out talking to Splitt', status: 504 });
    mockFetch.mockRejectedValueOnce(new Error('ECONNRESET'));
    expect(await filesApi.uploadFile(T, { folder: 'disputes', contentType: 'image/png', base64: PNG64 })).toEqual({ ok: false, error: 'Upload failed (network error)', status: 502 });
    mockFetch.mockResolvedValueOnce(makeResponse(true, 200, { success: true }));
    expect(await filesApi.uploadFile(T, { folder: 'disputes', contentType: 'image/png', base64: PNG64 })).toEqual({ ok: false, error: 'Upload succeeded but Splitt returned no file URL.' });
    mockFetch.mockResolvedValueOnce(makeResponse(true, 200, 'not json'));
    expect(await filesApi.uploadFile(T, { folder: 'disputes', contentType: 'image/png', base64: PNG64 })).toEqual({ ok: false, error: 'Upload succeeded but Splitt returned no file URL.' });
  });
});

describe('filesTools defs', () => {
  it('exports upload_file with access, scope, annotations and a useful description', () => {
    expect(filesTools.map((t) => t.name)).toEqual(['upload_file']);
    for (const def of filesTools) {
      expect(def.access).toBe('user');
      expect(def.scope).toBe('files');
      expect(def.description.length).toBeGreaterThanOrEqual(40);
      expect(def.description).not.toMatch(/\u2014/);
      expect(def.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      expect(typeof def.handler).toBe('function');
    }
  });

  it('forwards the caller token and returns the url with a folder-specific next step', async () => {
    const result = await uploadFile.handler({ folder: 'claims', contentType: 'image/png', base64: PNG64, filename: undefined }, { token: T, role: 'vendor' });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload).toMatchObject({ url: 'https://x.private.blob.vercel-storage.com/claims/abc.png', key: 'claims/abc.png', folder: 'claims' });
    expect(payload.nextStep).toMatch(/file_damage_claim/);
    expect(lastRequest().init.headers.Authorization).toBe(`Bearer ${T}`);
  });

  it('surfaces validation and backend failures as isError results', async () => {
    const bad = await uploadFile.handler({ folder: 'disputes', contentType: 'application/pdf', base64: PNG64 }, { token: T });
    expect(bad.isError).toBe(true);
    expect((bad.content[0] as { text: string }).text).toMatch(/image\/png, not application\/pdf/);
    mockFetch.mockResolvedValueOnce(makeResponse(false, 401, { message: 'Unauthorized' }));
    const denied = await uploadFile.handler({ folder: 'disputes', contentType: 'image/png', base64: PNG64 }, { token: T });
    expect(denied.isError).toBe(true);
    expect((denied.content[0] as { text: string }).text).toMatch(/Reconnect/);
  });
});
