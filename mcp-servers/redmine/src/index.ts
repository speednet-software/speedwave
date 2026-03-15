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
const AUTH_TOKEN = process.env.MCP_REDMINE_AUTH_TOKEN;

async function main(): Promise<void> {
  console.log(`${ts()} 🚀 Starting ${SERVER_NAME}...`);

  if (!AUTH_TOKEN) {
    console.error(
      `${ts()} FATAL: MCP_REDMINE_AUTH_TOKEN is required. ` +
        `${SERVER_NAME} must not run without authentication.`
    );
    process.exit(1);
  }

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
    auth: { token: AUTH_TOKEN },
    healthCheck: async () => {
      if (!redmineClient) {
        throw new Error('Redmine client not configured');
      }
    },
  });

  const actualPort = await server.start();
  process.stdout.write(JSON.stringify({ port: actualPort }) + '\n');
  console.log(`${ts()} ✅ ${SERVER_NAME} started on port ${actualPort} (auth enforced)`);
}

main().catch((error) => {
  console.error(`${ts()} Fatal error:`, error);
  process.exit(1);
});
