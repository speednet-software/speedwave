/**
 * MCP custom guard worker: one per custom MCP server, between the hub and the untrusted server.
 * @module mcp-custom-guard
 */

import { bootWorker, ts } from '@speedwave/mcp-shared';
import { readGuardConfig } from './config.js';
import { createGuardHandler } from './guard.js';
import { createPolicyStore } from './policy.js';

try {
  const config = readGuardConfig(process.env);
  const policy = createPolicyStore(config.policyFile, {
    service: config.serviceId,
    mode: config.upstream.mode,
  });
  await bootWorker({
    serverName: `mcp-${config.serviceId}`,
    version: '1.0.0',
    authTokenEnv: config.authTokenEnv,
    host: '0.0.0.0',
    makeTools: () => [],
    rpcHandler: createGuardHandler(config, policy),
  });
} catch (error) {
  console.error(`${ts()} FATAL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
