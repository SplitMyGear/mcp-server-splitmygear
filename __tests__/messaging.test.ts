import { messagingTools } from '../src/tools/messaging';
import { BackendApiError } from '../src/lib/backend-client';

// sendMessage + getConversations forward the caller's JWT to the backend
// (SPLIT-226). No Supabase: the MCP no longer has a direct service-role client.
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

    it('reuses an existing conversation when the backend 409s on create', async () => {
      const EXISTING = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      mockBackendRequest.mockImplementation(async (method: string, path: string) => {
        if (method === 'POST' && path === '/chat/conversations') {
          throw new BackendApiError(409, 'Conversation with this user already exists.');
        }
        if (method === 'GET' && path === '/chat/conversations') {
          return [
            { id: 'unrelated', participant1Id: 'zzzz', participant2Id: 'yyyy' },
            { id: EXISTING, participant1Id: 'me', participant2Id: RECIPIENT },
          ];
        }
        return { id: 'm2', content: 'follow up' };
      });
      const result = await messagingTools.sendMessage({ recipientId: RECIPIENT, content: 'follow up', token: TOKEN });
      expect(result.success).toBe(true);
      expect(result.conversationId).toBe(EXISTING);
      // The follow-up posts into the EXISTING conversation, not a freshly created one.
      expect(mockBackendRequest).toHaveBeenCalledWith(
        'POST',
        `/chat/conversations/${EXISTING}/messages`,
        expect.objectContaining({ token: TOKEN, body: { content: 'follow up' } }),
      );
    });

    it('fails gracefully when the 409 conversation cannot be located', async () => {
      mockBackendRequest.mockImplementation(async (method: string, path: string) => {
        if (method === 'POST' && path === '/chat/conversations') {
          throw new BackendApiError(409, 'Conversation with this user already exists.');
        }
        if (method === 'GET' && path === '/chat/conversations') return [];
        return { id: 'm3' };
      });
      const result = await messagingTools.sendMessage({ recipientId: RECIPIENT, content: 'hi', token: TOKEN });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Failed to resolve conversation/);
    });

    it('surfaces a non-409 conversation-create error', async () => {
      mockBackendRequest.mockImplementation(async (method: string, path: string) => {
        if (method === 'POST' && path === '/chat/conversations') {
          throw new BackendApiError(400, 'Cannot create a conversation with yourself.');
        }
        return { id: 'm4' };
      });
      const result = await messagingTools.sendMessage({ recipientId: RECIPIENT, content: 'hi', token: TOKEN });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/yourself/);
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

  describe('generateAIDraft (backend AI)', () => {
    it('returns the backend-drafted message', async () => {
      mockBackendRequest.mockResolvedValue({ draft: 'Hi! Yes, the kayak is available.' });
      const draft = await messagingTools.generateAIDraft('is the kayak available', 'renter');
      expect(draft).toBe('Hi! Yes, the kayak is available.');
      expect(mockBackendRequest).toHaveBeenCalledWith('POST', '/ai/draft-message', {
        body: { context: 'is the kayak available', userRole: 'renter', tone: 'professional' },
      });
    });

    it('forwards a custom tone', async () => {
      mockBackendRequest.mockResolvedValue({ draft: 'Hey there!' });
      await messagingTools.generateAIDraft('quick hello', 'vendor', 'casual');
      expect(mockBackendRequest).toHaveBeenCalledWith('POST', '/ai/draft-message', {
        body: { context: 'quick hello', userRole: 'vendor', tone: 'casual' },
      });
    });

    it('surfaces the disabled notice when the backend AI flag is off', async () => {
      mockBackendRequest.mockResolvedValue({ available: false, message: 'AI features are currently disabled.' });
      const draft = await messagingTools.generateAIDraft('context', 'renter');
      expect(draft).toContain('disabled');
    });

    it('returns an error string on backend failure', async () => {
      mockBackendRequest.mockRejectedValue(new BackendApiError(500, 'boom'));
      const draft = await messagingTools.generateAIDraft('context', 'renter');
      expect(draft).toBe('Error generating draft.');
    });
  });
});
