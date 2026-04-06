import OpenAI from 'openai';
import { SearchFilters } from './supabase';

const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY || 'MISSING_KEY',
  baseURL: 'https://openrouter.ai/api/v1',
  defaultHeaders: {
    'HTTP-Referer': 'https://splitmygear.com',
    'X-Title': 'SplitMyGear MCP',
  },
});

export const aiService = {
  async parseSearchQuery(query: string): Promise<Partial<SearchFilters>> {
    if (!process.env.OPENROUTER_API_KEY) {
      console.warn('OPENROUTER_API_KEY is not set. Natural language search will use simple keyword matching.');
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
      const response = await openai.chat.completions.create({
        model: 'meta-llama/llama-3.3-70b-instruct:free',
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
    if (!process.env.OPENROUTER_API_KEY) {
      console.warn('OPENROUTER_API_KEY is not set. Embedding-based search is disabled.');
      return [];
    }
    try {
      const response = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text,
      });

      return response.data[0].embedding;
    } catch (error) {
      console.error('Error generating embedding with AI:', error);
      return [];
    }
  },
};
