/**
 * MCP SharePoint Worker: isolated SharePoint/Graph API MCP server with per-service token isolation.
 * @module mcp-sharepoint
 */

import { bootWorker, ts } from '@speedwave/mcp-shared';
import { initializeSharePointClient, type SharePointClient } from './client.js';
import { createToolDefinitions } from './tools/index.js';

bootWorker<SharePointClient>({
  serverName: 'mcp-sharepoint',
  version: '1.0.0',
  displayName: 'SharePoint',
  authTokenEnv: 'MCP_SHAREPOINT_AUTH_TOKEN',
  host: '0.0.0.0',
  initClient: initializeSharePointClient,
  onNotConfigured: 'fail',
  makeTools: (client) => createToolDefinitions(client),
  makeHealthCheck: (client) => async () => {
    const health = client!.getHealthStatus();
    if (health.tokenSaveError) {
      throw new Error('Token refresh failed');
    }
    if (health.connection === 'failed') {
      throw new Error(`SharePoint siteId resolve failed: ${health.connectionError ?? 'unknown'}`);
    }
  },
}).catch((error) => {
  console.error(`${ts()} Fatal error:`, error);
  process.exit(1);
});
