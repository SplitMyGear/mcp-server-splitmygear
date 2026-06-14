import { backendRequest, BackendApiError } from '@/lib/backend-client';

/**
 * Content tools are thin clients of the backend AI (SPLIT-277), completing the
 * SPLIT-226 decouple: the MCP no longer calls an LLM provider directly (it held
 * no AI key in prod, so these tools were dead). The backend owns the AI provider,
 * prompts, token budget and fallbacks. A `{ available:false }` body means the
 * backend's AI feature flag is off — surface it rather than pretend success.
 */

interface DescriptionResponse {
  description?: string;
  available?: boolean;
  message?: string;
}

interface TitleResponse {
  title?: string;
  available?: boolean;
}

export const contentTools = {
  async generateListingDescription(
    name: string,
    category: string,
    keywords: string[],
  ): Promise<string> {
    try {
      const result = await backendRequest<DescriptionResponse>(
        'POST',
        '/ai/generate-description',
        {
          body: {
            category,
            name,
            // The backend prompt folds subAttributes in as "Specs"; pass the
            // MCP's keywords there so they shape the generated copy.
            ...(keywords?.length ? { subAttributes: { keyFeatures: keywords.join(', ') } } : {}),
          },
        },
      );
      if (result?.available === false) {
        return result.message || 'AI content generation is currently unavailable.';
      }
      return result?.description || 'Failed to generate description.';
    } catch (error) {
      return error instanceof BackendApiError
        ? `Error generating description: ${error.message}`
        : 'Error generating description.';
    }
  },

  async improveListingTitle(currentTitle: string): Promise<string> {
    try {
      const result = await backendRequest<TitleResponse>('POST', '/ai/improve-title', {
        body: { currentTitle },
      });
      // On the disabled flag or any empty result, return the input unchanged.
      if (result?.available === false) return currentTitle;
      return result?.title || currentTitle;
    } catch {
      return currentTitle;
    }
  },
};
