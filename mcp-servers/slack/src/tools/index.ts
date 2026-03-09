/**
 * Slack Tools Index
 *
 * Central registry for all Slack tools following the domain-tools pattern.
 */

import { ToolDefinition } from '../../../shared/dist/index.js';
import { SlackClients } from '../client.js';

export { withValidation, ToolResult } from './validation.js';

import { createChannelTools } from './channel-tools.js';
import { createUserTools } from './user-tools.js';

/**
 * Creates complete tool definitions array for Slack MCP server.
 * @param clients - Slack client instances
 */
export function createToolDefinitions(clients: SlackClients | null): ToolDefinition[] {
  return [...createChannelTools(clients), ...createUserTools(clients)];
}
