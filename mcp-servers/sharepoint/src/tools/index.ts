/**
 * SharePoint Tools Index
 *
 * Central registry for all SharePoint tools following the domain-tools pattern.
 */

import { ToolDefinition } from '@speedwave/mcp-shared';
import { SharePointClient } from '../client.js';

export { withValidation, ToolResult } from './validation.js';

import { createFileTools } from './file-tools.js';
import { createSyncTools } from './sync-tools.js';
import { createUserTools } from './user-tools.js';

/**
 * Creates complete tool definitions array for SharePoint MCP server.
 * @param client - SharePoint client instance
 */
export function createToolDefinitions(client: SharePointClient | null): ToolDefinition[] {
  return [...createFileTools(client), ...createSyncTools(client), ...createUserTools(client)];
}
