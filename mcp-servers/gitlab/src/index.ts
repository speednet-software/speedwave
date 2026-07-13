/**
 * MCP GitLab Worker: isolated GitLab MCP server with per-service token isolation.
 * @module mcp-gitlab
 */

import { bootWorker, ts, makeStandardHealthCheck } from '@speedwave/mcp-shared';
import { initializeGitLabClient, type GitLabClient } from './client.js';
import { createToolDefinitions } from './tools/index.js';

bootWorker<GitLabClient>({
  serverName: 'mcp-gitlab',
  version: '1.0.0',
  displayName: 'GitLab',
  authTokenEnv: 'MCP_GITLAB_AUTH_TOKEN',
  host: '0.0.0.0',
  initClient: initializeGitLabClient,
  makeTools: (client) => createToolDefinitions(client),
  makeHealthCheck: (client) =>
    client
      ? makeStandardHealthCheck(client.statusTracker, 'GitLab')
      : async () => {
          throw new Error('GitLab client not configured');
        },
}).catch((error) => {
  console.error(`${ts()} Fatal error:`, error);
  process.exit(1);
});
