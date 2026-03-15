/**
 * Validation Helpers for GitLab Tool Parameters
 */

import { ToolsCallResult, jsonResult, textResult, errorResult } from '@speedwave/mcp-shared';
import { GitLabClient } from '../client.js';

/**
 * Wrapper that handles client validation and error formatting.
 * Named withValidation for consistency with other MCP servers.
 * @param client - GitLab client instance
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
      return errorResult('GitLab not configured. Run: speedwave setup gitlab');
    }
    try {
      return await handler(client, params);
    } catch (error) {
      return errorResult(GitLabClient.formatError(error));
    }
  };
}
