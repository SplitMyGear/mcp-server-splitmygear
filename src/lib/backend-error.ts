/**
 * The backend's error message for a failed response. Shared by the JSON client
 * (`backend-client.ts`) and the multipart uploads (`postMultipart` in
 * `tools/_shared.ts`). Kept in its own module because several test suites mock
 * `backend-client` with a factory that would not carry this function.
 */

export interface ErrorMessageOptions {
  /**
   * Replaces both fallback prefixes ("Request failed" for a `message` array
   * with no strings, "Backend request failed" otherwise), e.g. 'Upload failed'.
   */
  label?: string;
  /** When `message` is an array with no strings, try `error` before the fallback. */
  emptyMessageFallsThroughToError?: boolean;
}

/**
 * Parse the backend's error shape: the global filter returns
 * `{ statusCode, error, message }` where message is a string or string[].
 */
export function extractErrorMessage(parsed: unknown, status: number, options: ErrorMessageOptions = {}): string {
  if (parsed && typeof parsed === 'object') {
    const body = parsed as { message?: unknown; error?: unknown };
    if (Array.isArray(body.message)) {
      const joined = body.message.filter((m) => typeof m === 'string').join('; ');
      if (joined) return joined;
      if (!options.emptyMessageFallsThroughToError) return `${options.label ?? 'Request failed'} (${status})`;
    }
    if (typeof body.message === 'string') {
      return body.message;
    }
    if (typeof body.error === 'string') {
      return body.error;
    }
  }
  return `${options.label ?? 'Backend request failed'} (${status})`;
}
