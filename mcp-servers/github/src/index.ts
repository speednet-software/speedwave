/**
 * MCP GitHub Worker
 *
 * Isolated GitHub MCP server with per-service token isolation.
 * Exposes the GitHub tools via `@octokit/rest` across multiple domains.
 * @module mcp-github
 */

import { bootWorker, ts, makeStandardHealthCheck } from '@speedwave/mcp-shared';
import { initializeGitHubClient, type GitHubClient } from './client.js';
import { createToolDefinitions } from './tools/index.js';

bootWorker<GitHubClient>({
  serverName: 'mcp-github',
  version: '1.0.0',
  displayName: 'GitHub',
  authTokenEnv: 'MCP_GITHUB_AUTH_TOKEN',
  host: '0.0.0.0',
  initClient: initializeGitHubClient,
  makeTools: (client) => createToolDefinitions(client),
  makeHealthCheck: (client) =>
    client
      ? makeStandardHealthCheck(client.statusTracker, 'GitHub')
      : async () => {
          throw new Error('GitHub client not configured');
        },
}).catch((error) => {
  console.error(`${ts()} Fatal error:`, error);
  process.exit(1);
});
