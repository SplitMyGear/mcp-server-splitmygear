import { getAIClient, isAIConfigured, chatModel } from '@/lib/ai-client';
import { backendRequest, BackendApiError } from '@/lib/backend-client';

/**
 * `sendMessage` / `getConversations` call the backend REST API forwarding the
 * caller's JWT (SPLIT-226 / M4): the backend derives the sender from the token
 * (never caller-supplied — closes the impersonation vector) and owns the chat
 * schema. `generateAIDraft` is a pure AI call. No Supabase: the whole MCP now
 * reads/writes through the backend, so there is no direct service-role client.
 */

// Defense in depth (M6): the route layer UUID-validates ids, but validating
// here too avoids a pointless backend round-trip on obviously-bad input.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

const AUTH_REQUIRED =
  'Authentication required: call with a user Bearer token (obtained from POST /api/v1/users/login).';

function toMessage(error: unknown, fallback: string): string {
  return error instanceof BackendApiError ? error.message : fallback;
}

export const messagingTools = {
  async sendMessage(params: {
    recipientId: string;
    content: string;
    conversationId?: string;
    token: string;
  }): Promise<{ success: boolean; message?: Record<string, unknown>; conversationId?: string; error?: string }> {
    if (!params.token) return { success: false, error: AUTH_REQUIRED };
    if (!isUuid(params.recipientId)) {
      return { success: false, error: 'Invalid recipientId: expected a UUID' };
    }
    if (params.conversationId && !isUuid(params.conversationId)) {
      return { success: false, error: 'Invalid conversationId: expected a UUID' };
    }
    try {
      let convId = params.conversationId;
      if (!convId) {
        // Resolve (or create) the conversation with the recipient. The backend
        // derives the initiator from the token.
        const conversation = await backendRequest<{ id: string }>('POST', '/chat/conversations', {
          token: params.token,
          body: { participantId: params.recipientId },
        });
        convId = conversation?.id;
        if (!convId) return { success: false, error: 'Failed to resolve conversation' };
      }

      const message = await backendRequest<Record<string, unknown>>(
        'POST',
        `/chat/conversations/${convId}/messages`,
        { token: params.token, body: { content: params.content } },
      );
      return { success: true, message, conversationId: convId };
    } catch (error) {
      return { success: false, error: toMessage(error, 'Failed to send message') };
    }
  },

  async getConversations(token: string): Promise<Record<string, unknown>[]> {
    if (!token) return [];
    try {
      const result = await backendRequest<Record<string, unknown>[]>('GET', '/chat/conversations', { token });
      return Array.isArray(result) ? result : [];
    } catch (error) {
      console.error('Get conversations error:', error);
      return [];
    }
  },

  async generateAIDraft(
    context: string,
    userRole: 'renter' | 'vendor',
    tone: string = 'professional'
  ): Promise<string> {
    if (!isAIConfigured()) {
      return 'AI drafting is disabled.';
    }

    const prompt = `
      You are an AI assistant for SplitMyGear.
      Draft a message for a ${userRole} based on the following context:
      "${context}"

      Tone: ${tone}
      Keep it concise, friendly, and helpful.
    `;

    try {
      const response = await getAIClient().chat.completions.create({
        model: chatModel(),
        messages: [{ role: 'user', content: prompt }],
      });

      return response.choices[0].message.content || 'Failed to generate draft.';
    } catch (error) {
      console.error('AI draft error:', error);
      return 'Error generating draft.';
    }
  },
};
