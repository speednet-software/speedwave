#!/usr/bin/env node
/**
 * MCP Context7 Worker
 *
 * Wraps the Context7 REST API (`https://context7.com/api/v2/*`) as an MCP
 * worker discoverable by the hub. Anonymous mode supported — see
 * docs/architecture/security.md for the privacy and rate-limit caveats.
 * @module mcp-context7
 */

import path from 'node:path';
import { createMCPServer, loadToken, ts } from '@speedwave/mcp-shared';
import { Context7Client } from './client.js';
import { createToolDefinitions } from './tools/index.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const SERVER_NAME = 'mcp-context7';
const AUTH_TOKEN = process.env.MCP_CONTEXT7_AUTH_TOKEN;
const TOKENS_DIR = process.env.TOKENS_DIR || '/tokens';

/**
 * Try to load the optional Context7 API key from `/tokens/api_key`.
 *
 * Returns `undefined` (anonymous mode) when the file is missing or empty;
 * propagates other errors so genuine misconfigurations (EACCES on a present
 * file) surface in startup logs rather than being silently swallowed.
 */
async function loadOptionalApiKey(): Promise<string | undefined> {
  const apiKeyPath = path.join(TOKENS_DIR, 'api_key');
  try {
    const key = await loadToken(apiKeyPath);
    return key.length > 0 ? key : undefined;
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes('Token file not found')) {
      return undefined;
    }
    throw e;
  }
}

async function main(): Promise<void> {
  console.log(`${ts()} 🚀 Starting ${SERVER_NAME}...`);

  if (!AUTH_TOKEN) {
    console.error(
      `${ts()} FATAL: MCP_CONTEXT7_AUTH_TOKEN is required. ` +
        `${SERVER_NAME} must not run without authentication.`
    );
    process.exit(1);
  }

  const apiKey = await loadOptionalApiKey();
  if (apiKey) {
    console.log(`${ts()} ✅ Context7 API key loaded (authenticated mode)`);
  } else {
    console.log(
      `${ts()} ℹ️  No Context7 API key — running in anonymous mode (per-IP rate limit applies)`
    );
  }

  const context7Client = new Context7Client({ apiKey });
  const tools = createToolDefinitions(context7Client);

  const server = createMCPServer({
    name: SERVER_NAME,
    version: '0.1.0',
    port: PORT,
    host: '0.0.0.0', // bind all interfaces — must be reachable from the container network
    tools,
    auth: { token: AUTH_TOKEN },
    // Local readiness only — calling Context7 here would burn anonymous quota
    // within hours (~2880 healthchecks/day per worker vs. 200/day per-IP limit).
    healthCheck: async () => {
      if (!context7Client) {
        throw new Error('Context7 client not initialised');
      }
    },
  });

  const actualPort = await server.start();
  process.stdout.write(JSON.stringify({ port: actualPort }) + '\n');
  console.log(`${ts()} ✅ ${SERVER_NAME} started on port ${actualPort} (auth enforced)`);
}

main().catch((error) => {
  console.error(`${ts()} Fatal error:`, error);
  process.exit(1);
});
