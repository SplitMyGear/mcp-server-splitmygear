import { SearchFilters } from './supabase';
import { getAIClient, isAIConfigured, chatModel, embeddingModel } from './ai-client';

export const aiService = {
  async parseSearchQuery(query: string): Promise<Partial<SearchFilters>> {
    if (!isAIConfigured()) {
      console.warn('No AI provider key set. Natural language search will use simple keyword matching.');
      return {};
    }
    const today = new Date().toISOString().split('T')[0];
    const systemPrompt = `
      You are an AI assistant for SplitMyGear, a high-value outdoor gear rental marketplace.
      Your task is to parse a natural language search query into a structured JSON object.
      
      Available filters:
      - location: string (City, neighborhood, or region)
      - checkIn: string (ISO date format YYYY-MM-DD)
      - checkOut: string (ISO date format YYYY-MM-DD)
      - guests: number (Integer)
      - category: string (One of: camping, hiking, water, snow, climbing, cycling, fishing, photography)
      - minPrice: number (Float)
      - maxPrice: number (Float)
      - query: string (Refined search keywords for name/description)

      Today's date is ${today}.
      If the user specifies relative dates like "this weekend", "next week", "tomorrow", calculate the specific dates.
      For "this weekend", use the coming Friday to Sunday.
      
      Return ONLY a JSON object.
    `;

    try {
      const response = await getAIClient().chat.completions.create({
        model: chatModel(),
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query },
        ],
        response_format: { type: 'json_object' },
      });

      const content = response.choices[0].message.content;
      if (!content) return {};

      return JSON.parse(content) as Partial<SearchFilters>;
    } catch (error) {
      console.error('Error parsing search query with AI:', error);
      return {};
    }
  },

  async generateEmbedding(text: string): Promise<number[]> {
    if (!isAIConfigured()) {
      console.warn('No AI provider key set. Embedding-based search is disabled.');
      return [];
    }
    try {
      const response = await getAIClient().embeddings.create({
        model: embeddingModel(),
        input: text,
      });

      return response.data[0].embedding;
    } catch (error) {
      console.error('Error generating embedding with AI:', error);
      return [];
    }
  },
};
