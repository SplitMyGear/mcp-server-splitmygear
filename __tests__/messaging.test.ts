import { messagingTools } from '../src/tools/messaging';
import { BackendApiError } from '../src/lib/backend-client';
import { AI_GENERATION_TIMEOUT_MS } from '../src/lib/timeouts';
import { generateAiMessageDraft } from '../src/tools/defs/renter';
import type { ToolContext } from '../src/tools/registry';

// sendMessage + getConversations forward the caller's JWT to the backend
// (SPLIT-226); the backend derives the sender from the token.
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
  beforeEach(() => {
    jest.clearAllMocks();
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

    it('fails gracefully when the backend returns no conversation id', async () => {
      mockBackendRequest.mockImplementation(async (method: string, path: string) => {
        if (method === 'POST' && path === '/chat/conversations') return {};
        return { id: 'm3' };
      });
      const result = await messagingTools.sendMessage({ recipientId: RECIPIENT, content: 'hi', token: TOKEN });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Failed to resolve conversation/);
    });

    it('surfaces a conversation-create error', async () => {
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
    it('returns the backend-drafted message and forwards the token', async () => {
      mockBackendRequest.mockResolvedValue({ draft: 'Hi! Yes, the kayak is available.' });
      const draft = await messagingTools.generateAIDraft('is the kayak available', 'renter', 'professional', TOKEN);
      expect(draft).toEqual({ ok: true, text: 'Hi! Yes, the kayak is available.' });
      expect(mockBackendRequest).toHaveBeenCalledWith('POST', '/ai/draft-message', {
        token: TOKEN,
        timeoutMs: AI_GENERATION_TIMEOUT_MS,
        body: { context: 'is the kayak available', userRole: 'renter', tone: 'professional' },
      });
    });

    it('forwards a custom tone and the token', async () => {
      mockBackendRequest.mockResolvedValue({ draft: 'Hey there!' });
      await messagingTools.generateAIDraft('quick hello', 'vendor', 'casual', TOKEN);
      expect(mockBackendRequest).toHaveBeenCalledWith('POST', '/ai/draft-message', {
        token: TOKEN,
        timeoutMs: AI_GENERATION_TIMEOUT_MS,
        body: { context: 'quick hello', userRole: 'vendor', tone: 'casual' },
      });
    });

    it('reports the disabled flag as a failure, never as the draft', async () => {
      mockBackendRequest.mockResolvedValue({ available: false, message: 'AI features are currently disabled.' });
      const draft = await messagingTools.generateAIDraft('context', 'renter', 'professional', TOKEN);
      expect(draft).toEqual({ ok: false, error: 'Nothing was generated: AI features are currently disabled. Write it yourself, or try again later.' });
    });

    it('reports an empty draft as a failure', async () => {
      mockBackendRequest.mockResolvedValue({ draft: '' });
      const draft = await messagingTools.generateAIDraft('context', 'renter', 'professional', TOKEN);
      expect(draft.ok).toBe(false);
    });

    it('reports a non-auth backend failure with its reason', async () => {
      mockBackendRequest.mockRejectedValue(new BackendApiError(500, 'boom'));
      const draft = await messagingTools.generateAIDraft('context', 'renter', 'professional', TOKEN);
      expect(draft).toEqual({ ok: false, error: 'Could not draft the message: boom' });
    });

    it('surfaces a re-auth error (not a silent template fallback) on a 401', async () => {
      mockBackendRequest.mockRejectedValue(new BackendApiError(401, 'Unauthorized'));
      const draft = await messagingTools.generateAIDraft('context', 'renter', 'professional', TOKEN);
      expect(draft.ok).toBe(false);
      expect(!draft.ok && draft.error).toMatch(/Authentication required/);
    });

    it('surfaces a re-auth error on a 403', async () => {
      mockBackendRequest.mockRejectedValue(new BackendApiError(403, 'Forbidden'));
      const draft = await messagingTools.generateAIDraft('context', 'vendor', 'professional', TOKEN);
      expect(!draft.ok && draft.error).toMatch(/Authentication required/);
    });
  });

  describe('generate_ai_message_draft (tool)', () => {
    const ctx: ToolContext = { userId: 'u', role: 'vendor_owner', token: TOKEN, kind: 'oauth' };
    const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content[0].text ?? '';

    it('returns the draft as plain text', async () => {
      mockBackendRequest.mockResolvedValue({ draft: 'See you at 9!' });
      const result = await generateAiMessageDraft.handler({ context: 'pickup', userRole: 'vendor', tone: 'friendly' }, ctx);
      expect(result.isError).toBeUndefined();
      expect(text(result)).toBe('See you at 9!');
    });

    it('is an error, not a draft, when Splitt AI is off (2026-09-27 LLM vendor run)', async () => {
      mockBackendRequest.mockResolvedValue({ available: false, message: 'AI features are currently disabled. They will be enabled once AI models are configured.' });
      const result = await generateAiMessageDraft.handler({ context: 'pickup', userRole: 'vendor', tone: 'friendly' }, ctx);
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/^Nothing was generated: AI features are currently disabled\./);
    });
  });
});
