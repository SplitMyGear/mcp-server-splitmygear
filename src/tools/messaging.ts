import { backendRequest, BackendApiError } from '@/lib/backend-client';

/**
 * `sendMessage` / `getConversations` call the backend REST API forwarding the
 * caller's JWT (SPLIT-226 / M4): the backend derives the sender from the token
 * (never caller-supplied — closes the impersonation vector) and owns the chat
 * schema. `generateAIDraft` now also goes through the backend AI (SPLIT-277) —
 * the MCP holds no LLM provider key of its own. No Supabase, no direct openai:
 * the whole MCP reads/writes through the backend.
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

interface ConversationRecord {
  id?: string;
  participant1Id?: string;
  participant2Id?: string;
}

/**
 * Resolve (or create) the conversation to post into.
 *
 * The backend's `POST /chat/conversations` is NOT idempotent — it 409s
 * ("Conversation with this user already exists") once a conversation between the
 * two users exists. An MCP caller that sent an earlier message and did not
 * retain the conversationId would then be unable to send ANY follow-up (every
 * subsequent send_message to that person failed). On a 409 we fall back to
 * listing the caller's conversations and reusing the existing one with this
 * recipient, so repeat messaging "just works".
 */
async function resolveOrCreateConversation(
  recipientId: string,
  token: string,
): Promise<string | undefined> {
  try {
    const created = await backendRequest<ConversationRecord>('POST', '/chat/conversations', {
      token,
      body: { participantId: recipientId },
    });
    return created?.id;
  } catch (error) {
    if (error instanceof BackendApiError && error.status === 409) {
      return findConversationWith(recipientId, token);
    }
    throw error;
  }
}

/** Find the caller's existing conversation with `recipientId`, if any. */
async function findConversationWith(
  recipientId: string,
  token: string,
): Promise<string | undefined> {
  const list = await backendRequest<ConversationRecord[]>('GET', '/chat/conversations', { token });
  if (!Array.isArray(list)) return undefined;
  const match = list.find(
    (c) => c && (c.participant1Id === recipientId || c.participant2Id === recipientId),
  );
  return match?.id;
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
        // derives the initiator from the token, and 409s if the pair already has
        // a conversation — resolveOrCreateConversation reuses it in that case.
        convId = await resolveOrCreateConversation(params.recipientId, params.token);
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
    try {
      const result = await backendRequest<{ draft?: string; available?: boolean; message?: string }>(
        'POST',
        '/ai/draft-message',
        { body: { context, userRole, tone } },
      );
      if (result?.available === false) {
        return result.message || 'AI drafting is currently unavailable.';
      }
      return result?.draft || 'Failed to generate draft.';
    } catch (error) {
      console.error('AI draft error:', toMessage(error, 'unknown'));
      return 'Error generating draft.';
    }
  },
};
