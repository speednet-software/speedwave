/**
 * MCP Office Worker
 *
 * Built-in MCP server for office documents — read/write/create/edit Word, Excel,
 * PowerPoint; generate PDF (Markdown/HTML→PDF, Office→PDF); manipulate PDF
 * (merge/split/rotate/watermark/forms); convert Office↔Office (LibreOffice
 * headless); render charts (matplotlib). A pure file processor: no service
 * credentials, no network egress, only `/workspace:rw` mounted. See ADR-055.
 * @module mcp-office
 */

import { bootWorker, ts } from '@speedwave/mcp-shared';
import { createToolDefinitions } from './tools/index.js';

// No service client (pure file processor) — bootWorker skips client init.
bootWorker({
  serverName: 'mcp-office',
  version: '1.0.0',
  authTokenEnv: 'MCP_OFFICE_AUTH_TOKEN',
  host: '0.0.0.0',
  makeTools: () => createToolDefinitions(),
}).catch((error) => {
  console.error(`${ts()} Fatal error:`, error);
  process.exit(1);
});
