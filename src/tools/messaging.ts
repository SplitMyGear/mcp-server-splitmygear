import { supabase, Conversation, Message } from '@/lib/supabase';
import OpenAI from 'openai';

// Defense in depth (M6): values interpolated into a PostgREST .or() filter
// string must be UUIDs. The route layer now UUID-validates ids and supplies a
// server-derived senderId, but guarding here too means the raw query can never
// be coerced into an injected filter.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertUuid(value: string, field: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`Invalid ${field}: expected a UUID`);
  }
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'MISSING_KEY',
});

export const messagingTools = {
  async sendMessage(
    senderId: string,
    recipientId: string,
    content: string,
    conversationId?: string
  ): Promise<{ success: boolean; message?: Message; error?: string }> {
    try {
      assertUuid(senderId, 'senderId');
      assertUuid(recipientId, 'recipientId');
      if (conversationId) assertUuid(conversationId, 'conversationId');
      let convId = conversationId;

      if (!convId) {
        // Try to find existing conversation between these two users
        const { data: existingConv } = await supabase
          .from('conversation')
          .select('id')
          .or(`and(participant1Id.eq.${senderId},participant2Id.eq.${recipientId}),and(participant1Id.eq.${recipientId},participant2Id.eq.${senderId})`)
          .single();

        if (existingConv) {
          convId = existingConv.id;
        } else {
          // Create new conversation
          const { data: newConv, error: convError } = await supabase
            .from('conversation')
            .insert({
              participant1Id: senderId,
              participant2Id: recipientId,
            })
            .select()
            .single();

          if (convError) return { success: false, error: convError.message };
          convId = newConv.id;
        }
      }

      const { data: message, error: msgError } = await supabase
        .from('message')
        .insert({
          conversationId: convId,
          senderId,
          content,
          isRead: false,
        })
        .select()
        .single();

      if (msgError) return { success: false, error: msgError.message };

      // Update conversation timestamp
      await supabase
        .from('conversation')
        .update({ updatedAt: new Date().toISOString() })
        .eq('id', convId);

      return { success: true, message };
    } catch (error) {
      console.error('Send message error:', error);
      return { success: false, error: 'Failed to send message' };
    }
  },

  async getConversations(userId: string): Promise<Conversation[]> {
    assertUuid(userId, 'userId');
    const { data } = await supabase
      .from('conversation')
      .select('*')
      .or(`participant1Id.eq.${userId},participant2Id.eq.${userId}`)
      .order('updatedAt', { ascending: false });

    return data || [];
  },

  async getMessages(conversationId: string, limit = 50): Promise<Message[]> {
    const { data } = await supabase
      .from('message')
      .select('*')
      .eq('conversationId', conversationId)
      .order('createdAt', { ascending: true })
      .limit(limit);

    return data || [];
  },

  async markAsRead(messageIds: string[]): Promise<{ success: boolean }> {
    const { error } = await supabase
      .from('message')
      .update({ isRead: true })
      .in('id', messageIds);

    return { success: !error };
  },

  async generateAIDraft(
    context: string,
    userRole: 'renter' | 'vendor',
    tone: string = 'professional'
  ): Promise<string> {
    if (!process.env.OPENAI_API_KEY) {
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
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
      });

      return response.choices[0].message.content || 'Failed to generate draft.';
    } catch (error) {
      console.error('AI draft error:', error);
      return 'Error generating draft.';
    }
  },
};
