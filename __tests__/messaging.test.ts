import { messagingTools } from '../src/tools/messaging';

// sendMessage + getConversations forward the caller's JWT to the backend
// (SPLIT-226 / M4). markAsRead/getMessages remain Supabase helpers.
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

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({ data: [], error: null }),
      update: jest.fn().mockReturnThis(),
      in: jest.fn().mockResolvedValue({ data: null, error: null }),
    })),
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

const TOKEN = 'header.payload.sig';
const RECIPIENT = '22222222-2222-4222-8222-222222222222';
const CONV = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('Messaging Tools', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, OPENAI_API_KEY: 'test-key' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('sendMessage (backend REST)', () => {
    it('sends a message into an existing conversation', async () => {
      mockBackendRequest.mockResolvedValue({ id: 'm1', content: 'hello' });
      const result = await messagingTools.sendMessage({ recipientId: RECIPIENT, content: 'hello', conversationId: CONV, token: TOKEN });
      expect(result.success).toBe(true);
      expect(result.message).toBeDefined();
      expect(result.conversationId).toBe(CONV);
      // No conversation creation when an id is supplied.
      expect(mockBackendRequest).toHaveBeenCalledWith(
        'POST',
        `/chat/conversations/${CONV}/messages`,
        expect.objectContaining({ token: TOKEN, body: { content: 'hello' } }),
      );
      expect(mockBackendRequest).not.toHaveBeenCalledWith('POST', '/chat/conversations', expect.anything());
    });

    it('creates/resolves a conversation when none is provided', async () => {
      mockBackendRequest.mockImplementation(async (method: string, path: string) => {
        if (method === 'POST' && path === '/chat/conversations') return { id: CONV };
        return { id: 'm1', content: 'hello' };
      });
      const result = await messagingTools.sendMessage({ recipientId: RECIPIENT, content: 'hello', token: TOKEN });
      expect(result.success).toBe(true);
      expect(result.conversationId).toBe(CONV);
      expect(mockBackendRequest).toHaveBeenCalledWith(
        'POST',
        '/chat/conversations',
        expect.objectContaining({ token: TOKEN, body: { participantId: RECIPIENT } }),
      );
    });

    it('rejects a non-UUID recipientId before any network call (M6 guard)', async () => {
      const result = await messagingTools.sendMessage({ recipientId: 'not-a-uuid); drop', content: 'hi', token: TOKEN });
      expect(result.success).toBe(false);
      expect(mockBackendRequest).not.toHaveBeenCalled();
    });

    it('requires a token', async () => {
      const result = await messagingTools.sendMessage({ recipientId: RECIPIENT, content: 'hi', token: '' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Authentication required/);
      expect(mockBackendRequest).not.toHaveBeenCalled();
    });
  });

  describe('getConversations (backend REST)', () => {
    it('returns the user conversations from the backend', async () => {
      mockBackendRequest.mockResolvedValue([{ id: CONV }]);
      const results = await messagingTools.getConversations(TOKEN);
      expect(results).toHaveLength(1);
      expect(mockBackendRequest).toHaveBeenCalledWith('GET', '/chat/conversations', { token: TOKEN });
    });

    it('returns an empty list when the backend errors', async () => {
      mockBackendRequest.mockRejectedValue(new Error('boom'));
      const results = await messagingTools.getConversations(TOKEN);
      expect(results).toEqual([]);
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
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.OPENCODE_API_KEY;
      const draft = await messagingTools.generateAIDraft('context', 'renter');
      expect(draft).toContain('disabled');
    });
  });
});
