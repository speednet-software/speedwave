/**
 * MCP Slack Worker
 *
 * Isolated Slack MCP server with per-service token isolation.
 * Architecture: Domain-tools pattern with separation of concerns.
 * @module mcp-slack
 */

import { bootWorker, ts, makeStandardHealthCheck } from '@speedwave/mcp-shared';
import { initializeSlackClients, type SlackClients } from './client.js';
import { createToolDefinitions } from './tools/index.js';

// initializeSlackClients always resolves a non-null object; `_tokensStatus`
// (not null) carries the "configured" signal — encoded via isConfigured.
bootWorker<SlackClients>({
  serverName: 'mcp-slack',
  version: '1.0.0',
  displayName: 'Slack',
  authTokenEnv: 'MCP_SLACK_AUTH_TOKEN',
  host: '0.0.0.0',
  initClient: initializeSlackClients,
  isConfigured: (clients) => clients?._tokensStatus === 'present',
  makeTools: (clients) => createToolDefinitions(clients!),
  makeHealthCheck: (clients, configured) =>
    configured && clients?.statusTracker
      ? makeStandardHealthCheck(clients.statusTracker, 'Slack')
      : async () => {
          throw new Error('Slack client not configured');
        },
}).catch((error) => {
  console.error(`${ts()} Fatal error:`, error);
  process.exit(1);
});
