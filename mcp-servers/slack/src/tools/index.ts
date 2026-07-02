/** Central registry for all Slack tools (domain-tools pattern). */

import { ToolDefinition } from '@speedwave/mcp-shared';
import { SlackClients } from '../client.js';

export { withValidation, ToolResult } from './validation.js';

import { createChannelTools } from './channel-tools.js';
import { createDmTools } from './dm-tools.js';
import { createFileTools } from './file-tools.js';
import { createUserTools } from './user-tools.js';

/**
 * Creates complete tool definitions array for Slack MCP server.
 * @param clients - Slack client instances; `_tokensStatus === 'missing'` means unconfigured.
 */
export function createToolDefinitions(clients: SlackClients): ToolDefinition[] {
  return [
    ...createChannelTools(clients),
    ...createDmTools(clients),
    ...createFileTools(clients),
    ...createUserTools(clients),
  ];
}
