/** Shared tool-handler error wrapping: run a Redmine operation and format any thrown error via RedmineClient.formatError with structured context. */

import { errorResult, type ToolsCallResult } from '@speedwave/mcp-shared';
import { RedmineClient, type ErrorContext } from '../client.js';

/**
 * Run a Redmine tool handler body, converting a thrown error into a formatted errorResult; `context` surfaces the attempted resource identifier(s).
 * @param context - Attempted resource identifier(s) surfaced in the error message.
 * @param fn - Handler body; its resolved value is returned as-is on success.
 */
export async function withRedmineErrors(
  context: ErrorContext | undefined,
  fn: () => Promise<ToolsCallResult>
): Promise<ToolsCallResult> {
  try {
    return await fn();
  } catch (error) {
    return errorResult(RedmineClient.formatError(error, context));
  }
}
