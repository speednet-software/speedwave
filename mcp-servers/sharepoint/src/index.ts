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
const AUTH_TOKEN = process.env.MCP_SHAREPOINT_AUTH_TOKEN;

//═══════════════════════════════════════════════════════════════════════════════
// Main Server
//═══════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log(`${ts()} 🚀 Starting ${SERVER_NAME}...`);

  if (!AUTH_TOKEN) {
    console.error(
      `${ts()} FATAL: MCP_SHAREPOINT_AUTH_TOKEN is required. ` +
        `${SERVER_NAME} must not run without authentication.`
    );
    process.exit(1);
  }

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
    auth: { token: AUTH_TOKEN },
    healthCheck: async () => {
      const { tokenSaveError } = sharepointClient.getHealthStatus();
      if (tokenSaveError) {
        throw new Error('Token refresh failed');
      }
    },
  });

  const actualPort = await server.start();
  process.stdout.write(JSON.stringify({ port: actualPort }) + '\n');
  console.log(`${ts()} ✅ ${SERVER_NAME} started on port ${actualPort} (auth enforced)`);
}

// Start server
main().catch((error) => {
  console.error(`${ts()} Fatal error:`, error);
  process.exit(1);
});
