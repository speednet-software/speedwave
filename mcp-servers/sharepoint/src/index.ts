/**
 * MCP SharePoint Worker
 *
 * Isolated SharePoint/Graph API MCP server with per-service token isolation.
 * Architecture: Domain-tools pattern with separation of concerns.
 * @module mcp-sharepoint
 */

import { bootWorker, ts } from '@speedwave/mcp-shared';
import { initializeSharePointClient, type SharePointClient } from './client.js';
import { createToolDefinitions } from './tools/index.js';

// SharePoint fails fast: OAuth token refresh cannot be deferred, so we refuse
// to start misconfigured (unlike Slack/GitLab/Redmine which warn-and-continue).
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
    // `unknown` during warmup → healthy; SharePoint siteId resolve runs in the
    // background after init and either succeeds (`ok`) or fails explicitly.
  },
}).catch((error) => {
  console.error(`${ts()} Fatal error:`, error);
  process.exit(1);
});
