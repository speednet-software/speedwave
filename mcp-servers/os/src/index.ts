/**
 * MCP OS Worker
 *
 * Native OS integrations (Reminders, Calendar, Mail, Notes).
 * Runs on the HOST (not in a container) — accesses native OS APIs
 * via platform-specific CLI binaries.
 *
 * Architecture:
 * - macOS: Swift CLI binaries (EventKit, AppleScript)
 * - Linux: Rust CLI binary (D-Bus, CalDAV)
 * - Windows: Rust CLI binary (WinRT, MAPI)
 *
 * Auth: Bearer token from MCP_OS_AUTH_TOKEN env var.
 * Hub reaches this worker via WORKER_OS_URL.
 * @module mcp-os
 */

import { createMCPServer, ts } from '../../shared/dist/index.js';
import { createToolDefinitions } from './tools/index.js';

//=============================================================================
// Configuration
//=============================================================================

const PORT = parseInt(process.env.PORT || '0', 10);
if (isNaN(PORT) || PORT < 0 || PORT > 65535) {
  console.error(`FATAL: Invalid PORT value: ${process.env.PORT}`);
  process.exit(1);
}
const SERVER_NAME = 'mcp-os';
const SERVER_VERSION = '1.0.0';
const AUTH_TOKEN = process.env.MCP_OS_AUTH_TOKEN;

//=============================================================================
// Main Server
//=============================================================================

async function main(): Promise<void> {
  console.log(`${ts()} Starting ${SERVER_NAME}...`);
  console.log(`${ts()} Platform: ${process.platform}`);

  if (!AUTH_TOKEN) {
    console.error(
      `${ts()} FATAL: MCP_OS_AUTH_TOKEN is required. ` +
        `mcp-os must not run without authentication.`
    );
    process.exit(1);
  }

  const tools = createToolDefinitions();

  const server = createMCPServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    port: PORT,
    tools,
    auth: { token: AUTH_TOKEN },
  });

  const actualPort = await server.start();

  // Machine-readable port announcement on stdout — Tauri reads this to know which port to use.
  // Machine-readable port announcement on stdout — Tauri scans all stdout lines for this JSON object.
  process.stdout.write(JSON.stringify({ port: actualPort }) + '\n');

  console.log(
    `${ts()} ${SERVER_NAME} started on port ${actualPort} (${tools.length} tools, auth enforced)`
  );
}

// Start server
main().catch((error) => {
  console.error(`${ts()} Fatal error:`, error);
  process.exit(1);
});
