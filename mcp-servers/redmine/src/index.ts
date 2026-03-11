/**
 * MCP Redmine Worker
 *
 * Isolated Redmine MCP server with per-service token isolation.
 * Exposes 23 tools: issue, time entry, journal, user, project, relation, and config operations.
 * @module mcp-redmine
 */

import { createMCPServer, ts } from '@speedwave/mcp-shared';
import { initializeRedmineClient } from './client.js';
import { createToolDefinitions } from './tools/index.js';

const PORT = parseInt(process.env.PORT || '3003', 10);
const SERVER_NAME = 'mcp-redmine';

async function main(): Promise<void> {
  console.log(`${ts()} 🚀 Starting ${SERVER_NAME}...`);

  const redmineClient = await initializeRedmineClient();

  if (!redmineClient) {
    console.warn(`${ts()} ⚠️  Redmine not configured (no API key or config)`);
    console.warn(`${ts()}    Run: speedwave setup redmine`);
    console.warn(`${ts()}    Server will start but tools will return errors until configured.`);
  } else {
    console.log(`${ts()} ✅ Redmine client initialized`);
  }

  const tools = createToolDefinitions(redmineClient);

  const server = createMCPServer({
    name: SERVER_NAME,
    version: '1.0.0',
    port: PORT,
    host: '0.0.0.0', // inside container — must be reachable from Docker network
    tools,
    healthCheck: async () => {
      if (!redmineClient) {
        throw new Error('Redmine client not configured');
      }
    },
  });

  await server.start();
}

main().catch((error) => {
  console.error(`${ts()} Fatal error:`, error);
  process.exit(1);
});
