/** Isolated Redmine MCP server, per-service token isolation, 23 tools across issue/time entry/journal/user/project/relation/config. */

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
