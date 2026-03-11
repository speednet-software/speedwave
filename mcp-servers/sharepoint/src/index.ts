/**
 * MCP SharePoint Worker
 *
 * Isolated SharePoint/Graph API MCP server with per-service token isolation.
 * Architecture: Domain-tools pattern with separation of concerns.
 * @module mcp-sharepoint
 */

import { createMCPServer, ts } from '@speedwave/mcp-shared';
import { initializeSharePointClient } from './client.js';
import { createToolDefinitions } from './tools/index.js';

//═══════════════════════════════════════════════════════════════════════════════
// Configuration
//═══════════════════════════════════════════════════════════════════════════════

const PORT = parseInt(process.env.PORT || '3002', 10);
const SERVER_NAME = 'mcp-sharepoint';
const SERVER_VERSION = '1.0.0';

//═══════════════════════════════════════════════════════════════════════════════
// Main Server
//═══════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log(`${ts()} 🚀 Starting ${SERVER_NAME}...`);

  // Initialize SharePoint client
  const sharepointClient = await initializeSharePointClient();

  if (!sharepointClient) {
    console.error(`${ts()} ❌ Failed to initialize SharePoint client - tokens not found or empty`);
    console.error(`${ts()}    Run: speedwave setup sharepoint`);
    process.exit(1);
  }

  console.log(`${ts()} ✅ SharePoint client initialized`);

  // Create MCP server with tool definitions from domain-tools
  const server = createMCPServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    port: PORT,
    host: '0.0.0.0', // inside container — must be reachable from Docker network
    tools: createToolDefinitions(sharepointClient),
    healthCheck: async () => {
      const { tokenSaveError } = sharepointClient.getHealthStatus();
      if (tokenSaveError) {
        throw new Error('Token refresh failed');
      }
    },
  });

  await server.start();
  console.log(`${ts()} ✅ ${SERVER_NAME} started on port ${PORT}`);
}

// Start server
main().catch((error) => {
  console.error(`${ts()} Fatal error:`, error);
  process.exit(1);
});
