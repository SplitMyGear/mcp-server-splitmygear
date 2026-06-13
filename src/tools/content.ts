import { getAIClient, isAIConfigured, chatModel } from '../lib/ai-client';

export const contentTools = {
  async generateListingDescription(
    name: string,
    category: string,
    keywords: string[]
  ): Promise<string> {
    if (!isAIConfigured()) {
      return 'AI Content Generation is disabled (missing API key).';
    }

    const prompt = `
      You are an expert copywriter for SplitMyGear, a high-value outdoor gear rental marketplace.
      Generate a professional, engaging, and SEO-optimized listing description.
      
      Item Name: ${name}
      Category: ${category}
      Key Features/Keywords: ${keywords.join(', ')}

      The description should:
      1. Highlight the quality and condition of the gear.
      2. Mention ideal use cases (e.g., specific locations or activities).
      3. Use a tone that is adventurous yet professional.
      4. Be approximately 150-250 words.
      5. Include a call to action.
    `;

    try {
      const response = await getAIClient().chat.completions.create({
        model: chatModel(),
        messages: [{ role: 'user', content: prompt }],
      });

      return response.choices[0].message.content || 'Failed to generate description.';
    } catch (error) {
      console.error('Content generation error:', error);
      return 'Error generating description.';
    }
  },

  async improveListingTitle(currentTitle: string): Promise<string> {
    if (!isAIConfigured()) {
      return currentTitle;
    }

    const prompt = `
      Optimize this gear rental listing title for maximum clicks and SEO on SplitMyGear.
      Current Title: "${currentTitle}"
      
      Requirements:
      - Keep it under 60 characters.
      - Include the brand and model if obvious.
      - Use strong, descriptive words (e.g., "Professional", "Ultra-light", "Heavy-duty").
      - Return ONLY the optimized title string.
    `;

    try {
      const response = await getAIClient().chat.completions.create({
        model: chatModel(),
        messages: [{ role: 'user', content: prompt }],
      });

      return response.choices[0].message.content?.replace(/"/g, '') || currentTitle;
    } catch (error) {
      console.error('Title improvement error:', error);
      return currentTitle;
    }
  },
};
