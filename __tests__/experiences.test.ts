import { experienceTools } from '../src/tools/experiences';
import { supabase } from '../src/lib/supabase';

const mockExperiences = [{ id: 'e1', title: 'Hiking Tour', category: 'outdoor', location: 'Seattle' }];
const mockSchedules = [{ id: 's1', experienceId: 'e1', spotsTotal: 10, spotsBooked: 2, date: '2024-06-01', status: 'available' }];

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
          single: jest.fn().mockResolvedValue({ 
            data: { ...mockSchedules[0], experience: { pricePerPerson: 100, hostId: 'h1' } }, 
            error: null 
          }),
        };
      }
      if (table === 'experience_booking') {
        return {
          insert: jest.fn().mockReturnThis(),
          update: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({ data: { id: 'b1' }, error: null }),
          eq: jest.fn().mockResolvedValue({ data: null, error: null }),
        };
      }
      return {};
    }),
  },
}));

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    paymentIntents: {
      create: jest.fn().mockResolvedValue({ id: 'pi_123', client_secret: 'secret' }),
    },
  }));
});

describe('Experience Tools', () => {
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

  describe('bookExperience', () => {
    it('should create booking and return payment secret', async () => {
      const result = await experienceTools.bookExperience('s1', 'u1', 2);
      expect(result.success).toBe(true);
      expect(result.clientSecret).toBe('secret');
    });

    it('should fail if spots not available', async () => {
      (supabase.from as jest.Mock).mockImplementationOnce(() => ({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({ 
          data: { spotsTotal: 10, spotsBooked: 9, experience: { pricePerPerson: 100 } }, 
          error: null 
        }),
      }));
      const result = await experienceTools.bookExperience('s1', 'u1', 5);
      expect(result.success).toBe(false);
      expect(result.error).toContain('spots');
    });
  });
});
