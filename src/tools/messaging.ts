import { backendRequest, BackendApiError } from '@/lib/backend-client';
import type { Conversation, PostResponse } from '@/lib/api-contract';
import { call, compact, qs } from './_shared';

/**
 * `sendMessage` / `getConversations` call the backend REST API forwarding the
 * caller's JWT (SPLIT-226 / M4): the backend derives the sender from the token
 * (never caller-supplied — closes the impersonation vector) and owns the chat
 * schema. `generateAIDraft` goes through the backend AI (SPLIT-277); the MCP
 * holds no LLM provider key of its own.
 *
 * SPLIT-197 §C-MCP: chat response types are derived from the backend OpenAPI
 * contract (`@/lib/api-contract`). `POST /chat/conversations/{id}/messages` is
 * spec-bound to `Message`; the conversation reads use the generated
 * `Conversation` entity (the /chat/conversations routes declare only a bare
 * `object` response — a contract gap — but the entity schema exists). The old
 * hand-rolled `ConversationRecord` interface is gone.
 */

/** POST /chat/conversations/{conversationId}/messages → `Message` (spec-bound). */
type SentMessage = PostResponse<'/api/v1/chat/conversations/{conversationId}/messages'>;

const AUTH_REQUIRED =
  'Authentication required: call with a user Bearer token (obtained from POST /api/v1/users/login).';

function toMessage(error: unknown, fallback: string): string {
  return error instanceof BackendApiError ? error.message : fallback;
}

/** A backend auth rejection — the caller's JWT is missing, invalid or expired. */
function isAuthError(error: unknown): error is BackendApiError {
  return error instanceof BackendApiError && (error.status === 401 || error.status === 403);
}

/**
 * Resolve (or create) the conversation to post into.
 *
 * The backend's `POST /chat/conversations` is idempotent (SPLIT-418): it returns
 * a newly created conversation with 201, or the pair's existing one with 200 —
 * never a 409.
 */
async function resolveOrCreateConversation(
  recipientId: string,
  token: string,
  context: { listingId?: string; bookingId?: string } = {},
): Promise<string | undefined> {
  const created = await backendRequest<Conversation>('POST', '/chat/conversations', {
    token,
    body: compact({ participantId: recipientId, ...context }),
  });
  return created?.id;
}

export const messagingTools = {
  async sendMessage(params: {
    recipientId: string;
    content: string;
    conversationId?: string;
    listingId?: string;
    bookingId?: string;
    token: string;
  }): Promise<{ success: boolean; message?: SentMessage; conversationId?: string; error?: string }> {
    if (!params.token) return { success: false, error: AUTH_REQUIRED };
    try {
      let convId = params.conversationId;
      if (!convId) {
        // Resolve (or create) the conversation with the recipient. The backend
        // derives the initiator from the token and returns the pair's existing
        // thread when they already have one.
        convId = await resolveOrCreateConversation(params.recipientId, params.token, {
          listingId: params.listingId,
          bookingId: params.bookingId,
        });
        if (!convId) return { success: false, error: 'Failed to resolve conversation' };
      }

      const message = await backendRequest<SentMessage>(
        'POST',
        `/chat/conversations/${convId}/messages`,
        { token: params.token, body: { content: params.content } },
      );
      return { success: true, message, conversationId: convId };
    } catch (error) {
      return { success: false, error: toMessage(error, 'Failed to send message') };
    }
  },

  /** Messages in one of the caller's conversations (the backend enforces membership). */
  getMessages(conversationId: string, token: string, since?: string) {
    return call<unknown[]>('GET', `/chat/conversations/${conversationId}/messages${qs({ since })}`, { token });
  },

  markConversationRead(conversationId: string, token: string) {
    return call('POST', `/chat/conversations/${conversationId}/read`, { token, body: {} });
  },

  async getConversations(token: string): Promise<Conversation[]> {
    if (!token) return [];
    try {
      const result = await backendRequest<Conversation[]>('GET', '/chat/conversations', { token });
      return Array.isArray(result) ? result : [];
    } catch (error) {
      console.error('Get conversations error:', error);
      return [];
    }
  },

  async generateAIDraft(
    context: string,
    userRole: 'renter' | 'vendor',
    tone: string = 'professional',
    // SPLIT-635: /ai/draft-message is now JwtAuthGuard-protected (SPLIT-585), so
    // this must forward the caller's JWT like every other authenticated tool.
    token?: string,
  ): Promise<string> {
    try {
      const result = await backendRequest<{ draft?: string; available?: boolean; message?: string }>(
        'POST',
        '/ai/draft-message',
        { token, body: { context, userRole, tone } },
      );
      if (result?.available === false) {
        return result.message || 'AI drafting is currently unavailable.';
      }
      return result?.draft || 'Failed to generate draft.';
    } catch (error) {
      // An auth failure is NOT a soft "fall back to a template" case — the tool
      // never ran. Surface it so the caller re-authenticates instead of silently
      // receiving a canned string that masks the broken auth.
      if (isAuthError(error)) return AUTH_REQUIRED;
      console.error('AI draft error:', toMessage(error, 'unknown'));
      return 'Error generating draft.';
    }
  },
};
