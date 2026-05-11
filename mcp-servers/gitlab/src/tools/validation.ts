/**
 * Validation Helpers for GitLab Tool Parameters
 */

import {
  ToolsCallResult,
  jsonResult,
  textResult,
  errorResult,
  notConfiguredMessage,
  ts,
} from '@speedwave/mcp-shared';
import { GitLabClient } from '../client.js';

/**
 * Wrapper that handles client validation and error formatting.
 * Named withValidation for consistency with other MCP servers. Also the single place
 * a tool handler's error is caught: GitLab API errors become a formatted user-facing
 * string, while anything that isn't a GitBeaker-style error (a programming bug in a
 * handler — `TypeError`, `ReferenceError`, …) is additionally logged at error level so
 * it doesn't masquerade silently as a "GitLab API error".
 * @param client - GitLab client instance (null when the service is not configured)
 * @param handler - Tool handler function
 */
export function withValidation<T>(
  client: GitLabClient | null,
  handler: (
    client: GitLabClient,
    params: T
  ) => Promise<ReturnType<typeof jsonResult> | ReturnType<typeof textResult>>
): (params: T) => Promise<ToolsCallResult> {
  return async (params: T) => {
    if (!client) {
      return errorResult(notConfiguredMessage('GitLab'));
    }
    try {
      return await handler(client, params);
    } catch (error) {
      // GitBeaker request/retry errors are `Error`s named "Gitbeaker…"; anything else that
      // reaches here is a programming bug in the handler — log it so it doesn't masquerade
      // as a plain "GitLab API error".
      const name = error instanceof Error ? error.name : '';
      if (!name.startsWith('Gitbeaker')) {
        console.error(`${ts()} Unexpected (non-GitBeaker) error in GitLab tool handler:`, error);
      }
      return errorResult(GitLabClient.formatError(error));
    }
  };
}
