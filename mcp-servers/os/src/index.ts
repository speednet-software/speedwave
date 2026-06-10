/**
 * MCP OS Worker
 *
 * Native OS integrations (Reminders, Calendar, Mail, Notes).
 * Runs on the HOST (not in a container) — accesses native OS APIs
 * via platform-specific CLI binaries.
 *
 * Architecture:
 * - macOS: Swift CLI binaries (EventKit, AppleScript)
 * - Windows: Rust CLI binary (WinRT, MAPI)
 *
 * Auth: Bearer token from MCP_OS_AUTH_TOKEN env var.
 * Hub reaches this worker via WORKER_OS_URL.
 * @module mcp-os
 */

import { bootWorker, ts } from '@speedwave/mcp-shared';
import { createToolDefinitions } from './tools/index.js';

// Host-side worker: defaultPort '0' (OS picks) and no explicit host, so the
// server binds MCP_LISTEN_HOST ?? '127.0.0.1' rather than a container 0.0.0.0.
console.log(`${ts()} Platform: ${process.platform}`);
bootWorker({
  serverName: 'mcp-os',
  version: '1.0.0',
  defaultPort: '0',
  authTokenEnv: 'MCP_OS_AUTH_TOKEN',
  makeTools: () => createToolDefinitions(),
}).catch((error) => {
  console.error(`${ts()} Fatal error:`, error);
  process.exit(1);
});
