/**
 * Validation Helpers for GitHub Tool Parameters
 */

import {
  ToolsCallResult,
  jsonResult,
  textResult,
  errorResult,
  notConfiguredMessage,
} from '@speedwave/mcp-shared';
import { GitHubClient } from '../client.js';

/**
 * Wrapper that handles client validation and error formatting.
 * Named withValidation for consistency with other MCP servers.
 * @param client - GitHub client instance
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
      return errorResult(GitHubClient.formatError(error));
    }
  };
}
