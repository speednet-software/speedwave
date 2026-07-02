/**
 * MCP OS Worker — host-side native OS integrations (Reminders, Calendar, Mail, Notes).
 * @module mcp-os
 */

import { bootWorker, ts } from '@speedwave/mcp-shared';
import { createToolDefinitions } from './tools/index.js';

// Host-side worker: defaultPort '0' (OS picks).
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
