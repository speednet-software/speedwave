#!/usr/bin/env node
/**
 * MCP Context7 Worker: wraps the Context7 REST API as an MCP worker, anonymous mode supported.
 * @module mcp-context7
 */

import { bootWorker, loadTokenFile, ts } from '@speedwave/mcp-shared';
import { Context7Client } from './client.js';
import { createToolDefinitions } from './tools/index.js';

/** Load optional Context7 API key from `/tokens/api_key`; returns undefined (anonymous) if missing/empty. */
async function loadOptionalApiKey(): Promise<string | undefined> {
  try {
    const key = await loadTokenFile('api_key');
    return key.length > 0 ? key : undefined;
  } catch (e) {
    // fs errno is at `e.cause.code`; non-ENOENT propagates.
    const cause = (e as { cause?: NodeJS.ErrnoException }).cause;
    if (cause?.code === 'ENOENT') {
      return undefined;
    }
    throw e;
  }
}

// Anonymous mode is valid; no healthCheck (would burn anonymous quota).
bootWorker<Context7Client>({
  serverName: 'mcp-context7',
  version: '0.1.0',
  authTokenEnv: 'MCP_CONTEXT7_AUTH_TOKEN',
  host: '0.0.0.0',
  initClient: async () => {
    const apiKey = await loadOptionalApiKey();
    if (apiKey) {
      console.log(`${ts()} ✅ Context7 API key loaded (authenticated mode)`);
    } else {
      console.log(
        `${ts()} ℹ️  No Context7 API key — running in anonymous mode (per-IP rate limit applies)`
      );
    }
    return new Context7Client({ apiKey });
  },
  makeTools: (client) => createToolDefinitions(client!),
}).catch((error) => {
  console.error(`${ts()} Fatal error:`, error);
  process.exit(1);
});
