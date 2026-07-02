/**
 * MCP Redmine Worker
 *
 * Isolated Redmine MCP server with per-service token isolation.
 * Exposes 23 tools: issue, time entry, journal, user, project, relation, and config operations.
 * @module mcp-redmine
 */

import { bootWorker, ts } from '@speedwave/mcp-shared';
import { initializeRedmineClient, type RedmineClient } from './client.js';
import { createToolDefinitions } from './tools/index.js';

bootWorker<RedmineClient>({
  serverName: 'mcp-redmine',
  version: '1.0.0',
  displayName: 'Redmine',
  authTokenEnv: 'MCP_REDMINE_AUTH_TOKEN',
  host: '0.0.0.0',
  initClient: initializeRedmineClient,
  makeTools: (client) => createToolDefinitions(client),
  makeHealthCheck: (client) => async () => {
    if (!client) {
      throw new Error('Redmine client not configured');
    }
  },
}).catch((error) => {
  console.error(`${ts()} Fatal error:`, error);
  process.exit(1);
});
