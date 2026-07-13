/**
 * User Tools - 1 tool for GitLab current-user identity resolution
 */

import {
  Tool,
  ToolDefinition,
  jsonResult,
  READ_ONLY_ANNOTATIONS,
  META_KEYS,
} from '@speedwave/mcp-shared';
import { GitLabClient } from '../client.js';
import { withValidation } from './validation.js';
import { TOOL_NAMES } from '../tool-names.js';

const getCurrentUserTool: Tool = {
  name: TOOL_NAMES.GET_CURRENT_USER,
  description:
    "Get the currently authenticated GitLab user (the configured token owner). Resolves 'me'/'my' for other tools' identity-scoped filters.",
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: true,
    [META_KEYS.USER_SCOPED]: true,
    [META_KEYS.CURRENT_USER_TOOL]: TOOL_NAMES.GET_CURRENT_USER,
  },
  keywords: ['gitlab', 'user', 'me', 'myself', 'current', 'whoami', 'identity'],
  example: 'const me = await gitlab.getCurrentUser()',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      id: { type: 'number' },
      username: { type: 'string' },
      name: { type: 'string' },
      email: { type: 'string' },
      web_url: { type: 'string' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Resolve the authenticated user',
      input: {},
    },
  ],
};

/**
 * Builds the GitLab user tool definitions.
 * @param client - GitLab client instance
 */
export function createUserTools(client: GitLabClient | null): ToolDefinition[] {
  return [
    {
      tool: getCurrentUserTool,
      handler: withValidation(client, async (c) => {
        const result = await c.getCurrentUser();
        return jsonResult({ success: true, ...result });
      }),
    },
  ];
}
