import { experienceTools } from '../src/tools/experiences';
import { supabase } from '../src/lib/supabase';

const mockExperiences = [{ id: 'e1', title: 'Hiking Tour', category: 'outdoor', location: 'Seattle' }];
const mockSchedules = [{ id: 's1', experienceId: 'e1', spotsTotal: 10, spotsBooked: 2, date: '2024-06-01', status: 'available' }];

// Read tools (search/details) still hit Supabase directly.
jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: jest.fn((table: string) => {
      if (table === 'experience') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          ilike: jest.fn().mockReturnThis(),
          limit: jest.fn().mockResolvedValue({ data: mockExperiences, error: null }),
          single: jest.fn().mockResolvedValue({ data: mockExperiences[0], error: null }),
        };
      }
      if (table === 'experience_schedule') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          gte: jest.fn().mockResolvedValue({ data: mockSchedules, error: null }),
        };
      }
      return {};
    }),
  },
}));

// bookExperience now forwards the caller's JWT to the backend (SPLIT-226 / M4).
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

describe('Experience Tools', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('searchExperiences', () => {
    it('should return experiences with filters', async () => {
      const results = await experienceTools.searchExperiences({ location: 'Seattle', category: 'outdoor' });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('e1');
    });
  });

  describe('getExperienceDetails', () => {
    it('should return experience and schedules', async () => {
      const result = await experienceTools.getExperienceDetails('e1');
      expect(result?.experience).toBeDefined();
      expect(result?.schedules).toHaveLength(1);
    });

    it('should return null if experience not found', async () => {
      (supabase.from as jest.Mock).mockImplementationOnce(() => ({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({ data: null, error: { message: 'Not found' } }),
      }));
      const result = await experienceTools.getExperienceDetails('invalid');
      expect(result).toBeNull();
    });
  });

  describe('bookExperience (backend REST)', () => {
    it('books via POST /experiences/bookings with the forwarded token', async () => {
      mockBackendRequest.mockResolvedValue({ success: true, booking: { id: 'eb1', status: 'pending' } });
      const result = await experienceTools.bookExperience({
        experienceId: 'e1',
        scheduleId: 's1',
        guests: 2,
        token: TOKEN,
      });
      expect(result.success).toBe(true);
      expect(result.bookingId).toBe('eb1');
      expect(mockBackendRequest).toHaveBeenCalledWith(
        'POST',
        '/experiences/bookings',
        expect.objectContaining({
          token: TOKEN,
          body: { experienceId: 'e1', scheduleId: 's1', numberOfGuests: 2 },
        }),
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
