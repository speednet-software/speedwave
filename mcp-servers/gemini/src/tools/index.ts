/**
 * Gemini Tools Index
 *
 * Central registry for all Gemini tools following the domain-tools pattern.
 * Pattern based on: domain-tools pattern used across MCP servers
 */

import { ToolDefinition } from '../../../shared/dist/index.js';
import { GeminiClient } from '../client.js';

// Import validation helpers
export { withValidation, ToolResult } from './validation.js';

// Import domain tools
import { createChatTools } from './chat-tools.js';

/**
 * Creates complete tool definitions array for Gemini MCP server.
 * @param client - The initialized Gemini client, or null if not configured
 * @returns Array of all Gemini tool definitions for MCP server
 */
export function createToolDefinitions(client: GeminiClient | null): ToolDefinition[] {
  return [
    // Chat domain
    ...createChatTools(client),
  ];
}
