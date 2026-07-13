/**
 * User Tools - 1 tool for resolving the token's authenticated GitHub identity
 */

import {
  META_KEYS,
  Tool,
  ToolDefinition,
  jsonResult,
  READ_ONLY_ANNOTATIONS,
} from '@speedwave/mcp-shared';
import { GitHubClient } from '../client.js';
import { withValidation } from './validation.js';
import { TOOL_NAMES } from '../tool-names.js';

const getCurrentUserTool: Tool = {
  name: TOOL_NAMES.GET_CURRENT_USER,
  description:
    "Get the GitHub user authenticated by the mounted token (login, name, email). Call this first to resolve 'me'/'my' before using assignee, creator, or author filters — none of them accept the literal string 'me'.",
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: false },
  keywords: ['github', 'user', 'me', 'whoami', 'current', 'authenticated', 'identity'],
  example: `const me = await github.${TOOL_NAMES.GET_CURRENT_USER}()`,
  inputSchema: {
    type: 'object',
    properties: {},
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      login: { type: 'string' },
      name: { type: 'string' },
      email: { type: 'string' },
      html_url: { type: 'string' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [{ description: 'Resolve the authenticated user', input: {} }],
};

/**
 * Builds the user tool definitions for the GitHub worker.
 * @param client - GitHub client instance (null when the service is not configured)
 */
export function createUserTools(client: GitHubClient | null): ToolDefinition[] {
  return [
    {
      tool: getCurrentUserTool,
      handler: withValidation(client, async (c) => {
        const result = await c.getCurrentUser();
        return jsonResult(result);
      }),
    },
  ];
}
