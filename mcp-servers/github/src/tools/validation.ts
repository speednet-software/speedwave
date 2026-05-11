/**
 * Validation Helpers for GitHub Tool Parameters
 */

import {
  ToolsCallResult,
  jsonResult,
  textResult,
  errorResult,
  notConfiguredMessage,
  ts,
} from '@speedwave/mcp-shared';
import { GitHubClient } from '../client.js';

/**
 * Wrapper that handles client validation and error formatting.
 * Named withValidation for consistency with other MCP servers. Also the single place
 * a tool handler's error is caught: GitHub API errors become a formatted user-facing
 * string, while anything that isn't an Octokit-style error (a programming bug in a
 * handler — `TypeError`, `ReferenceError`, …) is additionally logged at error level so
 * it doesn't masquerade silently as a "GitHub API error".
 * @param client - GitHub client instance (null when the service is not configured)
 * @param handler - Tool handler function
 */
export function withValidation<T>(
  client: GitHubClient | null,
  handler: (
    client: GitHubClient,
    params: T
  ) => Promise<ReturnType<typeof jsonResult> | ReturnType<typeof textResult>>
): (params: T) => Promise<ToolsCallResult> {
  return async (params: T) => {
    if (!client) {
      return errorResult(notConfiguredMessage('GitHub'));
    }
    try {
      return await handler(client, params);
    } catch (error) {
      if (typeof (error as { status?: unknown } | null)?.status !== 'number') {
        console.error(`${ts()} Unexpected (non-Octokit) error in GitHub tool handler:`, error);
      }
      return errorResult(GitHubClient.formatError(error));
    }
  };
}
