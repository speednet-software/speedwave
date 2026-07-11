/**
 * Tool-handler wrapper for the Atlassian worker.
 * @module mcp-atlassian/tools/validation
 */

import {
  withClientValidation,
  type ToolsCallResult,
  type jsonResult,
  type textResult,
} from '@speedwave/mcp-shared';
import { AtlassianClient } from '../client.js';
import type { StorageBodyInput } from '../adf.js';

/**
 * Wrap a tool handler with client-presence and error handling; `handler` runs only when `client` is non-null.
 * @param client - The Atlassian client (or `null` when the service is unconfigured).
 * @param handler - The handler, invoked only when `client` is non-null.
 * @returns A handler suitable for a tool definition.
 */
export function withValidation<T>(
  client: AtlassianClient | null,
  handler: (
    client: AtlassianClient,
    params: T
  ) => Promise<ReturnType<typeof jsonResult> | ReturnType<typeof textResult>>
): (params: T) => Promise<ToolsCallResult> {
  return withClientValidation(client, handler, {
    serviceName: 'Atlassian',
    formatError: (error) => AtlassianClient.formatError(error),
  });
}

/**
 * Map a Confluence body tool input to {@link StorageBodyInput}: `bodyStorage` (raw XHTML) takes precedence over `bodyText`.
 * @param p - The tool input fragment.
 * @param p.bodyStorage - Body as raw storage-representation XHTML (takes precedence).
 * @param p.bodyText - Body as plain text (used when `bodyStorage` is absent).
 * @returns The domain-shaped body input.
 */
export function toStorageBodyInput(p: {
  bodyStorage?: string;
  bodyText?: string;
}): StorageBodyInput {
  if (p.bodyStorage !== undefined) return { storage: p.bodyStorage };
  return { text: p.bodyText ?? '' };
}
