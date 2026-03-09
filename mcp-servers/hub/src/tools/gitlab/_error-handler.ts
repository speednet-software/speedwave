/**
 * Shared error handler for GitLab hub tools
 *
 * Provides consistent error formatting and logging across all GitLab tools.
 * Use handleExecutionError() in catch blocks for uniform error handling.
 */

import { ts } from '../../../../shared/dist/index.js';

/**
 * Formats an error into a user-friendly string message.
 * Handles various error types: Error instances, strings, objects with description/message.
 * @param error - The caught error (can be any type)
 * @returns Formatted error message string
 */
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object') {
    // GitLab API errors often have 'description' field
    if ('description' in error) {
      return String((error as { description: unknown }).description);
    }
    // Generic object with message
    if ('message' in error) {
      return String((error as { message: unknown }).message);
    }
    // Last resort: stringify the object
    try {
      return JSON.stringify(error);
    } catch {
      return 'Error object could not be serialized';
    }
  }
  return `Unexpected error type: ${typeof error}`;
}

/**
 * Handles execution errors with logging and formatted response.
 * Use this in catch blocks of all GitLab hub tools for consistent error handling.
 *
 * Note: Sensitive data is protected by PII Tokenizer before reaching Claude/Gemini.
 * Local container logs are not sanitized as they don't leave the Docker environment.
 * @param toolName - Name of the tool (for logging context)
 * @param params - Tool parameters
 * @param error - The caught error
 * @returns Formatted error response object
 * @example
 * ```typescript
 * try {
 *   await context.gitlab.deleteTag(params);
 *   return { success: true, message: 'Tag deleted' };
 * } catch (error) {
 *   return handleExecutionError('deleteTag', params, error);
 * }
 * ```
 */
export function handleExecutionError(
  toolName: string,
  params: Record<string, unknown>,
  error: unknown
): { success: false; error: string } {
  const errorMessage = formatError(error);

  // Log for debugging (appears in container logs only)
  console.error(`${ts()} [${toolName}] Operation failed`, {
    params,
    error: errorMessage,
    stack: error instanceof Error ? error.stack : undefined,
  });

  return { success: false, error: errorMessage };
}
