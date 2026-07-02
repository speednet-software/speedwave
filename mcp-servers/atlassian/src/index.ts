/**
 * MCP Atlassian Worker — isolated Jira & Confluence (Atlassian Cloud) server with per-service token isolation.
 * @module mcp-atlassian
 */

import { bootWorker, ts, makeStandardHealthCheck } from '@speedwave/mcp-shared';
import { initializeAtlassianClient, type AtlassianClient } from './client.js';
import { createToolDefinitions } from './tools/index.js';

bootWorker<AtlassianClient>({
  serverName: 'mcp-atlassian',
  version: '1.0.0',
  displayName: 'Atlassian',
  authTokenEnv: 'MCP_ATLASSIAN_AUTH_TOKEN',
  host: '0.0.0.0',
  initClient: initializeAtlassianClient,
  makeTools: (client) => createToolDefinitions(client),
  makeHealthCheck: (client) =>
    client
      ? makeStandardHealthCheck(client.statusTracker, 'Atlassian')
      : async () => {
          throw new Error('Atlassian client not configured');
        },
}).catch((error) => {
  console.error(`${ts()} Fatal error:`, error);
  process.exit(1);
});
