/**
 * MCP Slack Worker
 *
 * Isolated Slack MCP server with per-service token isolation.
 * Architecture: Domain-tools pattern with separation of concerns.
 * @module mcp-slack
 */

import { createMCPServer, ts } from '../../shared/dist/index.js';
import { initializeSlackClients } from './client.js';
import { createToolDefinitions } from './tools/index.js';

//═══════════════════════════════════════════════════════════════════════════════
// Configuration
//═══════════════════════════════════════════════════════════════════════════════

const PORT = parseInt(process.env.PORT || '3001', 10);
const SERVER_NAME = 'mcp-slack';
const SERVER_VERSION = '1.0.0';

//═══════════════════════════════════════════════════════════════════════════════
// Main Server
//═══════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log(`${ts()} 🚀 Starting ${SERVER_NAME}...`);

  // Initialize Slack clients (may be null if not configured)
  const slackClients = await initializeSlackClients();

  if (!slackClients) {
    console.warn(`${ts()} ⚠️  Slack not configured (no tokens)`);
    console.warn(`${ts()}    Run: speedwave setup slack`);
    console.warn(`${ts()}    Server will start but tools will return errors until configured.`);
  } else {
    console.log(`${ts()} ✅ Slack clients initialized`);
  }

  // Create MCP server with tool definitions from domain-tools
  const server = createMCPServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    port: PORT,
    host: '0.0.0.0', // inside container — must be reachable from Docker network
    tools: createToolDefinitions(slackClients),
    healthCheck: async () => {
      if (!slackClients) {
        throw new Error('Slack client not configured');
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
