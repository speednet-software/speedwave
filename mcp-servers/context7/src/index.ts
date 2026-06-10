#!/usr/bin/env node
/**
 * MCP Context7 Worker
 *
 * Wraps the Context7 REST API (`https://context7.com/api/v2/*`) as an MCP
 * worker discoverable by the hub. Anonymous mode supported — see
 * docs/architecture/security.md for the privacy and rate-limit caveats.
 * @module mcp-context7
 */

import { bootWorker, loadTokenFile, ts } from '@speedwave/mcp-shared';
import { Context7Client } from './client.js';
import { createToolDefinitions } from './tools/index.js';

/**
 * Try to load the optional Context7 API key from `/tokens/api_key`.
 *
 * Returns `undefined` (anonymous mode) when the file is missing or empty;
 * propagates other errors so genuine misconfigurations (EACCES on a present
 * file) surface in startup logs rather than being silently swallowed.
 */
async function loadOptionalApiKey(): Promise<string | undefined> {
  try {
    const key = await loadTokenFile('api_key');
    return key.length > 0 ? key : undefined;
  } catch (e) {
    // `loadToken` re-throws with `{ cause: originalErrnoException }`, so the fs
    // errno is reachable as `e.cause.code` — anything other than ENOENT
    // (EACCES, EISDIR, …) propagates so real misconfigs surface.
    const cause = (e as { cause?: NodeJS.ErrnoException }).cause;
    if (cause?.code === 'ENOENT') {
      return undefined;
    }
    throw e;
  }
}

// context7 always constructs a client (anonymous mode is valid, not "not
// configured"), so initClient never returns null. No healthCheck: probing
// Context7 here would burn the anonymous quota (index.test.ts guards this).
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
