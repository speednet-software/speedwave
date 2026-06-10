/**
 * Tool-handler wrapper for the Atlassian worker: short-circuits to a
 * "not configured" error when the client is absent, and turns any thrown error
 * into a sanitized {@link errorResult} via {@link AtlassianClient.formatError}.
 * Named `withValidation` for consistency with the other workers.
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
 * Wrap a tool handler with client-presence and error handling (shared Family-B
 * wrapper {@link withClientValidation}).
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
  return withClientValidation(client, handler, {
    serviceName: 'Atlassian',
    formatError: (error) => AtlassianClient.formatError(error),
  });
}

/**
 * Map a Confluence body tool input (`{ bodyStorage?, bodyText? }`) to the domain
 * {@link StorageBodyInput} shape (`{ storage?, text? }`). `bodyStorage` (raw
 * storage-representation XHTML) takes precedence; otherwise `bodyText` is used
 * (an absent text body becomes the empty string).
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
