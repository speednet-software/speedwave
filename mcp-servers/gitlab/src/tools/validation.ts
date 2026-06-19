/**
 * Validation helpers for GitLab tool parameters; delegates to {@link withClientValidation}.
 */

import {
  withClientValidation,
  ts,
  type ToolsCallResult,
  type jsonResult,
  type textResult,
} from '@speedwave/mcp-shared';
import { GitLabClient } from '../client.js';

/**
 * Wrap a tool handler with client-presence and error handling.
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
  return withClientValidation(client, handler, {
    serviceName: 'GitLab',
    formatError: (error) => GitLabClient.formatError(error),
    onUnexpectedError: (error) => {
      const name = error instanceof Error ? error.name : '';
      if (!name.startsWith('Gitbeaker')) {
        console.error(`${ts()} Unexpected (non-GitBeaker) error in GitLab tool handler:`, error);
      }
    },
  });
}
