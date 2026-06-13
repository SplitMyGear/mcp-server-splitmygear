import { messagingTools } from '../src/tools/messaging';
import { supabase } from '../src/lib/supabase';

const mockConv = { id: 'c1', participant1Id: 'u1', participant2Id: 'u2' };
const mockMsg = { id: 'm1', content: 'hello', senderId: 'u1', conversationId: 'c1' };

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: jest.fn((table: string) => {
      if (table === 'conversation') {
        return {
          select: jest.fn().mockReturnThis(),
          or: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          order: jest.fn().mockResolvedValue({ data: [mockConv], error: null }),
          single: jest.fn().mockResolvedValue({ data: mockConv, error: null }),
          insert: jest.fn().mockReturnThis(),
          update: jest.fn().mockReturnThis(),
        };
      }
      if (table === 'message') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          order: jest.fn().mockReturnThis(),
          limit: jest.fn().mockResolvedValue({ data: [mockMsg], error: null }),
          insert: jest.fn().mockReturnThis(),
          update: jest.fn().mockReturnThis(),
          in: jest.fn().mockResolvedValue({ data: null, error: null }),
          single: jest.fn().mockResolvedValue({ data: mockMsg, error: null }),
        };
      }
      return {};
    }),
  },
}));

jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue({
          choices: [{ message: { content: 'AI draft response' } }],
        }),
      },
    },
  }));
});

describe('Messaging Tools', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, OPENAI_API_KEY: 'test-key' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('sendMessage', () => {
    it('should send a message in existing conversation', async () => {
      const result = await messagingTools.sendMessage('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'hello', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
      expect(result.success).toBe(true);
      expect(result.message).toBeDefined();
    });

    it('should find existing conversation if none provided', async () => {
      const result = await messagingTools.sendMessage('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'hello');
      expect(result.success).toBe(true);
      expect(supabase.from).toHaveBeenCalledWith('conversation');
    });

    it('rejects non-UUID ids (M6 filter-injection guard)', async () => {
      const result = await messagingTools.sendMessage('not-a-uuid); drop', '22222222-2222-4222-8222-222222222222', 'hi');
      expect(result.success).toBe(false);
    });
  });

  describe('getConversations', () => {
    it('should return user conversations', async () => {
      const results = await messagingTools.getConversations('11111111-1111-4111-8111-111111111111');
      expect(results).toHaveLength(1);
    });
  });

  describe('markAsRead', () => {
    it('should update message status', async () => {
      const result = await messagingTools.markAsRead(['m1']);
      expect(result.success).toBe(true);
    });
  });

  describe('generateAIDraft', () => {
    it('should return AI generated draft', async () => {
      const draft = await messagingTools.generateAIDraft('context', 'renter');
      expect(draft).toBe('AI draft response');
    });

    it('should return error if key is missing', async () => {
      delete process.env.OPENAI_API_KEY;
      const draft = await messagingTools.generateAIDraft('context', 'renter');
      expect(draft).toContain('disabled');
    });
  });
});
