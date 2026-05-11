/**
 * Tool-handler wrapper for the Atlassian worker: short-circuits to a
 * "not configured" error when the client is absent, and turns any thrown error
 * into a sanitized {@link errorResult} via {@link AtlassianClient.formatError}.
 * Named `withValidation` for consistency with the other workers.
 * @module mcp-atlassian/tools/validation
 */

import {
  type ToolsCallResult,
  type jsonResult,
  type textResult,
  errorResult,
  notConfiguredMessage,
} from '@speedwave/mcp-shared';
import { AtlassianClient } from '../client.js';

/**
 * Wrap a tool handler with client-presence and error handling.
 * @template T - The tool's parsed input params type.
 * @param client - The Atlassian client (or `null` when the service is unconfigured).
 * @param handler - The handler, invoked only when `client` is non-null.
 * @returns A handler suitable for a {@link ToolDefinition}.
 */
export function withValidation<T>(
  client: AtlassianClient | null,
  handler: (
    client: AtlassianClient,
    params: T
  ) => Promise<ReturnType<typeof jsonResult> | ReturnType<typeof textResult>>
): (params: T) => Promise<ToolsCallResult> {
  return async (params: T) => {
    if (!client) {
      return errorResult(notConfiguredMessage('Atlassian'));
    }
    try {
      return await handler(client, params);
    } catch (error) {
      return errorResult(AtlassianClient.formatError(error));
    }
  };
}
