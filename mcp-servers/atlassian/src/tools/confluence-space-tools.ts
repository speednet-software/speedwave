/**
 * Confluence space tools — listSpaces, getSpace. 2 tools.
 * @module mcp-atlassian/tools/confluence-space-tools
 */

import {
  type Tool,
  type ToolDefinition,
  jsonResult,
  errorResult,
  notConfiguredMessage,
  META_KEYS,
  READ_ONLY_ANNOTATIONS,
} from '@speedwave/mcp-shared';
import { AtlassianClient } from '../client.js';
import { createConfluenceSpacesClient } from '../domains/confluence-spaces.js';
import { withValidation } from './validation.js';

const listSpacesTool: Tool = {
  name: 'listSpaces',
  description:
    'List Confluence spaces visible to the account (restricted to the configured space allowlist, if any).',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: false },
  keywords: ['confluence', 'spaces', 'list', 'browse', 'wiki'],
  example: 'const { spaces } = await atlassian.listSpaces({ keys: ["DEV", "DOCS"] })',
  inputSchema: {
    type: 'object',
    properties: {
      keys: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter to these space keys (optional)',
      },
      limit: { type: 'number', description: 'Max spaces (default 50, max 100)' },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      spaces: { type: 'array' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    { description: 'All spaces', input: {} },
    { description: 'Specific spaces', input: { keys: ['DEV', 'DOCS'] } },
    { description: 'Limit results', input: { limit: 10 } },
  ],
};

const getSpaceTool: Tool = {
  name: 'getSpace',
  description: 'Get a single Confluence space by key.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['confluence', 'space', 'get', 'show', 'detail', 'wiki'],
  example: 'const space = await atlassian.getSpace({ spaceKey: "DEV" })',
  inputSchema: {
    type: 'object',
    properties: { spaceKey: { type: 'string', description: 'Confluence space key' } },
    required: ['spaceKey'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      space: { type: 'object' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [{ description: 'By key', input: { spaceKey: 'DEV' } }],
};

/**
 * Build the Confluence space tool definitions; `client` is `null` when not configured.
 * @param client - The Atlassian client (`null` when not configured).
 * @returns Tool definitions for Confluence spaces.
 */
export function createConfluenceSpaceTools(client: AtlassianClient | null): ToolDefinition[] {
  const tools = [listSpacesTool, getSpaceTool];
  if (!client) {
    const unconfigured = async () => errorResult(notConfiguredMessage('Atlassian'));
    return tools.map((tool) => ({ tool, handler: unconfigured }));
  }
  const spaces = createConfluenceSpacesClient(client);

  return [
    {
      tool: listSpacesTool,
      handler: withValidation(client, async (_c, params) => {
        const { keys, limit } = params as { keys?: string[]; limit?: number };
        return jsonResult({ spaces: await spaces.list({ keys, limit }) });
      }),
    },
    {
      tool: getSpaceTool,
      handler: withValidation(client, async (_c, params) => {
        const { spaceKey } = params as { spaceKey: string };
        return jsonResult({ space: await spaces.getByKey(spaceKey) });
      }),
    },
  ];
}
