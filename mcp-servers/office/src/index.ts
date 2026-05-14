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

import { createMCPServer, ts } from '@speedwave/mcp-shared';
import { createToolDefinitions } from './tools/index.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const SERVER_NAME = 'mcp-office';
const AUTH_TOKEN = process.env.MCP_OFFICE_AUTH_TOKEN;

/** Start the office worker: enforce the internal Bearer token, register tools, listen. */
async function main(): Promise<void> {
  console.log(`${ts()} 🚀 Starting ${SERVER_NAME}...`);

  if (!AUTH_TOKEN) {
    console.error(
      `${ts()} FATAL: MCP_OFFICE_AUTH_TOKEN is required. ` +
        `${SERVER_NAME} must not run without authentication.`
    );
    process.exit(1);
  }

  const tools = createToolDefinitions();

  const server = createMCPServer({
    name: SERVER_NAME,
    version: '1.0.0',
    port: PORT,
    host: '0.0.0.0', // inside the container — must be reachable from the container network
    tools,
    auth: { token: AUTH_TOKEN },
  });

  const actualPort = await server.start();
  process.stdout.write(JSON.stringify({ port: actualPort }) + '\n');
  console.log(
    `${ts()} ✅ ${SERVER_NAME} started on port ${actualPort} (auth enforced, ${tools.length} tools)`
  );
}

main().catch((error) => {
  console.error(`${ts()} Fatal error:`, error);
  process.exit(1);
});
