/**
 * All MCP Servers ↔ Hub Registry Parity Test
 *
 * Ensures all tools in each MCP server are registered in hub.
 * Prevents "tool not found" errors at runtime.
 *
 * Triggered by: _tests/run.sh (Stage 3)
 */

import { describe, it, expect } from 'vitest';
import { TOOL_REGISTRY } from './tool-registry.js';

// Import tool definitions from each MCP server
import { createToolDefinitions as createRedmineTools } from '../../redmine/dist/tools/index.js';
import { createToolDefinitions as createGitlabTools } from '../../gitlab/dist/tools/index.js';
import { createToolDefinitions as createSharepointTools } from '../../sharepoint/dist/tools/index.js';
import { createToolDefinitions as createSlackTools } from '../../slack/dist/tools/index.js';

/**
 * Get tool names from each MCP server.
 * Tools are defined statically, pass null for client.
 */
const MCP_SERVERS: Record<string, () => string[]> = {
  redmine: () => createRedmineTools(null).map((t) => t.tool.name),
  gitlab: () => createGitlabTools(null).map((t) => t.tool.name),
  sharepoint: () => createSharepointTools(null).map((t) => t.tool.name),
  slack: () => createSlackTools(null).map((t) => t.tool.name),
};

/**
 * Convert snake_case to camelCase
 * Server tools use snake_case, hub registry uses camelCase
 */
function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

describe('MCP Servers ↔ Hub Registry Parity', () => {
  for (const [service, getServerTools] of Object.entries(MCP_SERVERS)) {
    describe(service, () => {
      it('all server tools are in hub registry', () => {
        const hubTools = Object.keys(TOOL_REGISTRY[service] || {});
        const serverTools = getServerTools();

        const missing = serverTools.filter((t) => !hubTools.includes(toCamelCase(t)));

        if (missing.length > 0) {
          throw new Error(
            `Missing in hub registry for ${service}:\n` +
              missing.map((t) => `  - ${t}`).join('\n') +
              `\n\nFix: Add these to hub/src/tools/${service}/`
          );
        }

        expect(missing).toEqual([]);
      });
    });
  }
});
