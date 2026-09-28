import { backendRequest, BackendApiError } from '@/lib/backend-client';
import { AI_GENERATION_TIMEOUT_MS } from '@/lib/timeouts';
import type { PostResponse } from '@/lib/api-contract';
import { aiUnavailableMessage, isAiUnavailable, type AiText } from './_shared';

/**
 * Content tools are thin clients of the backend AI (SPLIT-277). The backend owns
 * the AI provider, prompts, token budget and fallbacks. A `{ available:false }`
 * body means the backend's AI feature flag is off. Every helper returns an
 * `AiText`, so that case, an empty result and any error reach the model as a
 * failure, never as text it could mistake for generated copy.
 *
 * SPLIT-635: the backend added `JwtAuthGuard` to every `/ai/*` route (SPLIT-585),
 * so these tools MUST forward the caller's JWT (like every other authenticated
 * MCP tool). Without it every call 401s. On an auth failure we surface a clear
 * "please re-authenticate" error instead of a silent fallback (returning the
 * unchanged input title / a canned string) that masks the broken auth.
 */

// SPLIT-197 §C-MCP: the /ai response bodies are spec-bound (SPLIT-1307,
// vendored-spec commit b1e2dc8), so both are derived rather than hand-rolled.
type DescriptionResponse = PostResponse<'/api/v1/ai/generate-description'>;
type TitleResponse = PostResponse<'/api/v1/ai/improve-title'>;

const AUTH_REQUIRED =
  'Authentication required: call with a user Bearer token (obtained from POST /api/v1/users/login) to use AI content tools.';

/** A backend auth rejection — the caller's JWT is missing, invalid or expired. */
function isAuthError(error: unknown): error is BackendApiError {
  return error instanceof BackendApiError && (error.status === 401 || error.status === 403);
}

function sameTitle(a: string, b: string): boolean {
  const norm = (t: string) => t.trim().replace(/\s+/g, ' ').toLowerCase();
  return norm(a) === norm(b);
}

export const contentTools = {
  async generateListingDescription(
    name: string,
    category: string,
    keywords: string[],
    token: string,
  ): Promise<AiText> {
    try {
      const result = await backendRequest<DescriptionResponse>(
        'POST',
        '/ai/generate-description',
        {
          token,
          timeoutMs: AI_GENERATION_TIMEOUT_MS,
          body: {
            category,
            name,
            // The backend prompt folds subAttributes in as "Specs"; pass the
            // MCP's keywords there so they shape the generated copy.
            ...(keywords?.length ? { subAttributes: { keyFeatures: keywords.join(', ') } } : {}),
          },
        },
      );
      if (isAiUnavailable(result)) return { ok: false, error: aiUnavailableMessage(result) };
      if (!result?.description) return { ok: false, error: "Splitt's AI returned no description. Write it yourself, or try again." };
      return { ok: true, text: result.description };
    } catch (error) {
      if (isAuthError(error)) return { ok: false, error: AUTH_REQUIRED };
      return {
        ok: false,
        error: error instanceof BackendApiError ? `Could not generate the description: ${error.message}` : 'Could not generate the description.',
      };
    }
  },

  async improveListingTitle(currentTitle: string, token: string): Promise<AiText> {
    try {
      const result = await backendRequest<TitleResponse>('POST', '/ai/improve-title', {
        token,
        timeoutMs: AI_GENERATION_TIMEOUT_MS,
        body: { currentTitle },
      });
      // Returning the input unchanged here once read as "this title is already
      // as good as it gets" when nothing had run at all (SPLIT-1501).
      if (isAiUnavailable(result)) return { ok: false, error: aiUnavailableMessage(result) };
      if (!result?.title) return { ok: false, error: "Splitt's AI returned no title. Keep the current one or write one yourself." };
      // The backend answers with the ORIGINAL title when its model fails or
      // returns nothing, so an unchanged title is "nothing suggested", never a
      // success: in 0.4 s it read as a rewrite that had run (SPLIT-1608).
      if (sameTitle(result.title, currentTitle)) {
        return { ok: false, error: "Splitt's AI suggested no change (it may be unavailable right now). Keep the current title or write one yourself." };
      }
      return { ok: true, text: result.title };
    } catch (error) {
      // An auth failure is NOT a soft "keep the original title" case — the tool
      // never ran. Surface it so the caller re-authenticates instead of
      // silently believing their title could not be improved.
      if (isAuthError(error)) return { ok: false, error: AUTH_REQUIRED };
      return {
        ok: false,
        error: error instanceof BackendApiError ? `Could not improve the title: ${error.message}` : 'Could not improve the title.',
      };
    }
  },
};
