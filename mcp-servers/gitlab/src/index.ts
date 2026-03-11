/**
 * MCP GitLab Worker
 *
 * Isolated GitLab MCP server with per-service token isolation.
 * Exposes 46 tools via `@gitbeaker/rest` across 12 domains.
 * @module mcp-gitlab
 */

import { createMCPServer, ts } from '@speedwave/mcp-shared';
import { initializeGitLabClient } from './client.js';
import { createToolDefinitions } from './tools/index.js';

const PORT = parseInt(process.env.PORT || '3004', 10);
const SERVER_NAME = 'mcp-gitlab';

async function main(): Promise<void> {
  console.log(`${ts()} 🚀 Starting ${SERVER_NAME}...`);

  const gitlabClient = await initializeGitLabClient();

  if (!gitlabClient) {
    console.warn(`${ts()} ⚠️  GitLab not configured (no token or host URL)`);
    console.warn(`${ts()}    Run: speedwave setup gitlab`);
    console.warn(`${ts()}    Server will start but tools will return errors until configured.`);
  } else {
    console.log(`${ts()} ✅ GitLab client initialized`);
  }

  const tools = createToolDefinitions(gitlabClient);

  const server = createMCPServer({
    name: SERVER_NAME,
    version: '1.0.0',
    port: PORT,
    host: '0.0.0.0', // inside container — must be reachable from Docker network
    tools,
    healthCheck: async () => {
      if (!gitlabClient) {
        throw new Error('GitLab client not configured');
      }
    },
  });

  await server.start();
}

main().catch((error) => {
  console.error(`${ts()} Fatal error:`, error);
  process.exit(1);
});
