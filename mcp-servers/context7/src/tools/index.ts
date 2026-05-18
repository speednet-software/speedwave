/**
 * Aggregate tool definitions for the Context7 worker.
 * @module mcp-context7/tools
 */

import { ToolDefinition } from '@speedwave/mcp-shared';
import { Context7Client } from '../client.js';
import { createResolveLibraryIdTool } from './resolve_library_id.js';
import { createQueryDocsTool } from './query_docs.js';

/**
 * Build the full list of Context7 tool definitions.
 * @param client - Configured Context7 client
 */
export function createToolDefinitions(client: Context7Client): ToolDefinition[] {
  return [createResolveLibraryIdTool(client), createQueryDocsTool(client)];
}

export { resolveLibraryIdTool, createResolveLibraryIdTool } from './resolve_library_id.js';
export { queryDocsTool, createQueryDocsTool } from './query_docs.js';
