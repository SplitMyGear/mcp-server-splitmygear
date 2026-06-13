import { backendRequest, BackendApiError, backendBaseUrl } from '../src/lib/backend-client';

const mockFetch = jest.fn();

function makeResponse(ok: boolean, status: number, body: unknown) {
  return {
    ok,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

describe('backendRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (global as unknown as { fetch: jest.Mock }).fetch = mockFetch;
  });

  it('issues a GET without an Authorization header when no token is given', async () => {
    mockFetch.mockResolvedValue(makeResponse(true, 200, { id: 'x' }));
    const result = await backendRequest<{ id: string }>('GET', '/listings/1');
    expect(result.id).toBe('x');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${backendBaseUrl()}/listings/1`);
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it('forwards the token as a Bearer header and serializes the body', async () => {
    mockFetch.mockResolvedValue(makeResponse(true, 201, { id: 'b1' }));
    await backendRequest('POST', '/bookings', { token: 'tok123', body: { listingId: 'l1' } });
    const [, init] = mockFetch.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok123');
    expect(JSON.parse(init.body)).toEqual({ listingId: 'l1' });
  });

  it('throws BackendApiError with a string message on a 4xx', async () => {
    mockFetch.mockResolvedValue(makeResponse(false, 404, { statusCode: 404, error: 'Not Found', message: 'Booking not found' }));
    await expect(backendRequest('GET', '/bookings/none')).rejects.toMatchObject({
      name: 'BackendApiError',
      status: 404,
      message: 'Booking not found',
    });
  });

  it('joins an array validation message', async () => {
    mockFetch.mockResolvedValue(makeResponse(false, 400, { message: ['a must be a UUID', 'b is required'] }));
    await expect(backendRequest('POST', '/bookings', { body: {} })).rejects.toThrow('a must be a UUID; b is required');
  });

  it('falls back to the error field, then a generic message', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(false, 403, { error: 'Forbidden' }));
    await expect(backendRequest('POST', '/x')).rejects.toThrow('Forbidden');

    mockFetch.mockResolvedValueOnce(makeResponse(false, 500, '<html>oops</html>'));
    await expect(backendRequest('GET', '/y')).rejects.toThrow('Backend request failed (500)');
  });

  it('exposes BackendApiError with the HTTP status', async () => {
    mockFetch.mockResolvedValue(makeResponse(false, 409, { message: 'conflict' }));
    try {
      await backendRequest('POST', '/bookings');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BackendApiError);
      expect((e as BackendApiError).status).toBe(409);
    }
  });
});
