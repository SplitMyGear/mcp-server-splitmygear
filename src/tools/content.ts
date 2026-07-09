import { backendRequest, BackendApiError } from '@/lib/backend-client';

/**
 * Content tools are thin clients of the backend AI (SPLIT-277), completing the
 * SPLIT-226 decouple: the MCP no longer calls an LLM provider directly (it held
 * no AI key in prod, so these tools were dead). The backend owns the AI provider,
 * prompts, token budget and fallbacks. A `{ available:false }` body means the
 * backend's AI feature flag is off — surface it rather than pretend success.
 *
 * SPLIT-635: the backend added `JwtAuthGuard` to every `/ai/*` route (SPLIT-585),
 * so these tools MUST forward the caller's JWT (like every other authenticated
 * MCP tool). Without it every call 401s. On an auth failure we surface a clear
 * "please re-authenticate" error instead of a silent fallback (returning the
 * unchanged input title / a canned string) that masks the broken auth.
 */

// SPLIT-197 §C-MCP contract gap: the backend types the /ai REQUEST bodies
// (GenerateDescriptionDto, ImproveTitleDto) but declares NO typed RESPONSE
// schema for /ai/generate-description or /ai/improve-title — openapi-typescript
// emits a bare `Record<string, never>`, so these can't be derived from the spec.
// These local interfaces document the real response shape the tools read; a
// backend `@ApiResponse({ type })` on the /ai routes would let them be generated.
interface DescriptionResponse {
  description?: string;
  available?: boolean;
  message?: string;
}

interface TitleResponse {
  title?: string;
  available?: boolean;
}

const AUTH_REQUIRED =
  'Authentication required: call with a user Bearer token (obtained from POST /api/v1/users/login) to use AI content tools.';

/** A backend auth rejection — the caller's JWT is missing, invalid or expired. */
function isAuthError(error: unknown): error is BackendApiError {
  return error instanceof BackendApiError && (error.status === 401 || error.status === 403);
}

export const contentTools = {
  async generateListingDescription(
    name: string,
    category: string,
    keywords: string[],
    token: string,
  ): Promise<string> {
    try {
      const result = await backendRequest<DescriptionResponse>(
        'POST',
        '/ai/generate-description',
        {
          token,
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
      if (isAuthError(error)) return AUTH_REQUIRED;
      return error instanceof BackendApiError
        ? `Error generating description: ${error.message}`
        : 'Error generating description.';
    }
  },

  async improveListingTitle(currentTitle: string, token: string): Promise<string> {
    try {
      const result = await backendRequest<TitleResponse>('POST', '/ai/improve-title', {
        token,
        body: { currentTitle },
      });
      // On the disabled flag or any empty result, return the input unchanged.
      if (result?.available === false) return currentTitle;
      return result?.title || currentTitle;
    } catch (error) {
      // An auth failure is NOT a soft "keep the original title" case — the tool
      // never ran. Surface it so the caller re-authenticates instead of
      // silently believing their title could not be improved.
      if (isAuthError(error)) return AUTH_REQUIRED;
      return currentTitle;
    }
  },
};
