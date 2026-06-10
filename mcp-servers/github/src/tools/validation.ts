/**
 * Validation Helpers for GitHub Tool Parameters
 *
 * `withValidation` delegates to the shared Family-B wrapper
 * ({@link withClientValidation}): not-configured gate + error mapping. The
 * unexpected-error hook logs anything that isn't an Octokit-style error (a
 * programming bug in a handler) so it doesn't masquerade as a "GitHub API error".
 */

import {
  withClientValidation,
  ts,
  type ToolsCallResult,
  type jsonResult,
  type textResult,
} from '@speedwave/mcp-shared';
import { GitHubClient } from '../client.js';

/**
 * Wrap a tool handler with client-presence and error handling.
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
  return withClientValidation(client, handler, {
    serviceName: 'GitHub',
    formatError: (error) => GitHubClient.formatError(error),
    onUnexpectedError: (error) => {
      if (typeof (error as { status?: unknown } | null)?.status !== 'number') {
        console.error(`${ts()} Unexpected (non-Octokit) error in GitHub tool handler:`, error);
      }
    },
  });
}
