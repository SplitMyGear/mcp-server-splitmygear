import { experienceTools } from '../src/tools/experiences';

// All experience tools now go through the backend REST client (SPLIT-226).
const mockBackendRequest = jest.fn();
jest.mock('../src/lib/backend-client', () => {
  class BackendApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'BackendApiError';
      this.status = status;
    }
  }
  return {
    BackendApiError,
    backendRequest: (...args: unknown[]) => mockBackendRequest(...args),
  };
});

const TOKEN = 'header.payload.sig';

describe('Experience Tools (backend REST)', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('searchExperiences', () => {
    it('queries GET /packages with filters and returns the experiences array (SPLIT-220 canonical alias)', async () => {
      mockBackendRequest.mockResolvedValue({ success: true, experiences: [{ id: 'e1', title: 'Hiking Tour' }] });
      const results = await experienceTools.searchExperiences({ location: 'Seattle', category: 'outdoor' });
      expect(results).toHaveLength(1);
      expect((results[0] as { id: string }).id).toBe('e1');
      const [method, path] = mockBackendRequest.mock.calls[0];
      expect(method).toBe('GET');
      expect(path).toContain('/packages?');
      // SPLIT-220: never the legacy /experiences path.
      expect(path).not.toMatch(/^\/experiences(\?|\/|$)/);
      expect(path).toContain('location=Seattle');
      expect(path).toContain('category=outdoor');
    });

    it('returns [] when the backend errors', async () => {
      mockBackendRequest.mockRejectedValue(new Error('boom'));
      const results = await experienceTools.searchExperiences({});
      expect(results).toEqual([]);
    });
  });

  describe('getExperienceDetails', () => {
    it('returns the experience plus its schedules from the public /packages endpoints (SPLIT-220 canonical alias)', async () => {
      mockBackendRequest.mockImplementation(async (_method: string, path: string) => {
        if (/\/packages\/e1\/schedules/.test(path)) return { success: true, schedules: [{ id: 's1' }] };
        if (/\/packages\/e1$/.test(path)) return { success: true, experience: { id: 'e1' } };
        throw new Error(`unexpected ${path}`);
      });
      const result = await experienceTools.getExperienceDetails('e1');
      expect(result?.experience).toBeDefined();
      expect(result?.schedules).toHaveLength(1);
      // SPLIT-220: both calls hit /packages, never the legacy /experiences path.
      for (const call of mockBackendRequest.mock.calls) {
        expect(call[1]).toMatch(/^\/packages\/e1/);
      }
    });

    it('returns null when the experience is not found (backend 404)', async () => {
      const { BackendApiError } = jest.requireMock('../src/lib/backend-client');
      mockBackendRequest.mockRejectedValue(new BackendApiError(404, 'Experience not found'));
      const result = await experienceTools.getExperienceDetails('missing');
      expect(result).toBeNull();
    });

    it('still returns the experience when the schedules fetch fails', async () => {
      mockBackendRequest.mockImplementation(async (_method: string, path: string) => {
        if (/schedules/.test(path)) throw new Error('schedules down');
        return { success: true, experience: { id: 'e1' } };
      });
      const result = await experienceTools.getExperienceDetails('e1');
      expect(result?.experience).toBeDefined();
      expect(result?.schedules).toEqual([]);
    });
  });

  describe('bookExperience', () => {
    it('books via POST /packages/bookings with the forwarded token (SPLIT-220 canonical alias)', async () => {
      mockBackendRequest.mockResolvedValue({ success: true, booking: { id: 'eb1', status: 'pending' } });
      const result = await experienceTools.bookExperience({ experienceId: 'e1', scheduleId: 's1', guests: 2, token: TOKEN });
      expect(result.success).toBe(true);
      expect(result.bookingId).toBe('eb1');
      expect(mockBackendRequest).toHaveBeenCalledWith(
        'POST',
        '/packages/bookings',
        expect.objectContaining({ token: TOKEN, body: { experienceId: 'e1', scheduleId: 's1', numberOfGuests: 2 } }),
      );
    });

    it('requires a token', async () => {
      const result = await experienceTools.bookExperience({ experienceId: 'e1', guests: 2, token: '' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Authentication required/);
      expect(mockBackendRequest).not.toHaveBeenCalled();
    });

    it('surfaces a capacity error from the backend', async () => {
      const { BackendApiError } = jest.requireMock('../src/lib/backend-client');
      mockBackendRequest.mockRejectedValue(new BackendApiError(409, 'Not enough spots available'));
      const result = await experienceTools.bookExperience({ experienceId: 'e1', guests: 5, token: TOKEN });
      expect(result.success).toBe(false);
      expect(result.error).toContain('spots');
    });
  });
});
