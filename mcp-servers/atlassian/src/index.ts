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
