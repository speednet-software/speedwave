/**
 * MCP GitLab Worker
 *
 * Isolated GitLab MCP server with per-service token isolation.
 * Exposes 46 tools via `@gitbeaker/rest` across 12 domains.
 * @module mcp-gitlab
 */

import { createMCPServer, ts, notConfiguredMessage, retryAsync } from '@speedwave/mcp-shared';
import { initializeGitLabClient } from './client.js';
import { createToolDefinitions } from './tools/index.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const SERVER_NAME = 'mcp-gitlab';
const AUTH_TOKEN = process.env.MCP_GITLAB_AUTH_TOKEN;

async function main(): Promise<void> {
  console.log(`${ts()} 🚀 Starting ${SERVER_NAME}...`);

  if (!AUTH_TOKEN) {
    console.error(
      `${ts()} FATAL: MCP_GITLAB_AUTH_TOKEN is required. ` +
        `${SERVER_NAME} must not run without authentication.`
    );
    process.exit(1);
  }

  const gitlabClient = await retryAsync(initializeGitLabClient, {
    maxRetries: 3,
    baseDelayMs: 2000,
    label: 'GitLab client init',
  });

  if (!gitlabClient) {
    console.warn(`${ts()} ⚠️  ${notConfiguredMessage('GitLab')}`);
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
    auth: { token: AUTH_TOKEN },
    healthCheck: async () => {
      if (!gitlabClient) {
        throw new Error('GitLab client not configured');
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
