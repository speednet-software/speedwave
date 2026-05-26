/**
 * MCP Atlassian Worker
 *
 * Isolated Jira & Confluence (Atlassian Cloud) MCP server with per-service token
 * isolation. Built on a thin `axios` HTTP client (no external Atlassian SDK —
 * see `docs/guides/integrations.md` for the rationale). Exposes 33 tools across
 * Jira (issues, comments, projects, Agile boards/sprints) and Confluence
 * (spaces, pages, comments, labels, attachments).
 * @module mcp-atlassian
 */

import {
  createMCPServer,
  ts,
  notConfiguredMessage,
  retryAsync,
  makeStandardHealthCheck,
} from '@speedwave/mcp-shared';
import { initializeAtlassianClient } from './client.js';
import { createToolDefinitions } from './tools/index.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const SERVER_NAME = 'mcp-atlassian';
const AUTH_TOKEN = process.env.MCP_ATLASSIAN_AUTH_TOKEN;

async function main(): Promise<void> {
  console.log(`${ts()} 🚀 Starting ${SERVER_NAME}...`);

  if (!AUTH_TOKEN) {
    console.error(
      `${ts()} FATAL: MCP_ATLASSIAN_AUTH_TOKEN is required. ` +
        `${SERVER_NAME} must not run without authentication.`
    );
    process.exit(1);
  }

  const atlassianClient = await retryAsync(initializeAtlassianClient, {
    maxRetries: 3,
    baseDelayMs: 2000,
    label: 'Atlassian client init',
  });

  if (!atlassianClient) {
    console.warn(`${ts()} ⚠️  ${notConfiguredMessage('Atlassian')}`);
    console.warn(`${ts()}    Server will start but tools will return errors until configured.`);
  } else {
    console.log(`${ts()} ✅ Atlassian client initialized`);
  }

  const tools = createToolDefinitions(atlassianClient);

  const server = createMCPServer({
    name: SERVER_NAME,
    version: '1.0.0',
    port: PORT,
    host: '0.0.0.0', // inside container — must be reachable from the container network
    tools,
    auth: { token: AUTH_TOKEN },
    healthCheck: atlassianClient
      ? makeStandardHealthCheck(atlassianClient.statusTracker, 'Atlassian')
      : async () => {
          throw new Error('Atlassian client not configured');
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
