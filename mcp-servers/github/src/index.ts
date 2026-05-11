/**
 * MCP GitHub Worker
 *
 * Isolated GitHub MCP server with per-service token isolation.
 * Exposes 45 tools via `@octokit/rest` across multiple domains.
 * @module mcp-github
 */

import { createMCPServer, ts, notConfiguredMessage, retryAsync } from '@speedwave/mcp-shared';
import { initializeGitHubClient } from './client.js';
import { createToolDefinitions } from './tools/index.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const SERVER_NAME = 'mcp-github';
const AUTH_TOKEN = process.env.MCP_GITHUB_AUTH_TOKEN;

async function main(): Promise<void> {
  console.log(`${ts()} 🚀 Starting ${SERVER_NAME}...`);

  if (!AUTH_TOKEN) {
    console.error(
      `${ts()} FATAL: MCP_GITHUB_AUTH_TOKEN is required. ` +
        `${SERVER_NAME} must not run without authentication.`
    );
    process.exit(1);
  }

  const githubClient = await retryAsync(initializeGitHubClient, {
    maxRetries: 3,
    baseDelayMs: 2000,
    label: 'GitHub client init',
  });

  if (!githubClient) {
    console.warn(`${ts()} ⚠️  ${notConfiguredMessage('GitHub')}`);
    console.warn(`${ts()}    Server will start but tools will return errors until configured.`);
  } else {
    console.log(`${ts()} ✅ GitHub client initialized`);
  }

  const tools = createToolDefinitions(githubClient);

  const server = createMCPServer({
    name: SERVER_NAME,
    version: '1.0.0',
    port: PORT,
    host: '0.0.0.0', // inside container — must be reachable from Docker network
    tools,
    auth: { token: AUTH_TOKEN },
    healthCheck: async () => {
      if (!githubClient) {
        throw new Error('GitHub client not configured');
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
