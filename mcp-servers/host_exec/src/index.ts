/**
 * `host_exec` MCP worker — runs user-whitelisted project-toolchain commands on
 * the HOST, in the project directory, no shell. Per-project (one process per
 * project on its own `127.0.0.1` port, spawned by Speedwave Desktop or CLI; the
 * hub reaches it via `WORKER_HOST_EXEC_URL`). Not a container; no per-call
 * confirmation (enabling host_exec is the consent — ADR-054). Env inputs:
 * `PORT` (0 = OS picks), `HOST_EXEC_AUTH_TOKEN` (required), `HOST_EXEC_CONFIG_PATH`
 * (the validated whitelist snapshot), `HOST_EXEC_LOG_FILE` (audit log).
 * @module host_exec
 */

import { createMCPServer, ts } from '@speedwave/mcp-shared';
import { readConfigSnapshot } from './config.js';
import { buildTools } from './tools.js';

const SERVER_NAME = 'host_exec';
const SERVER_VERSION = '1.0.0';

/**
 * Parse and validate the `PORT` env var.
 * @returns The port (0 for "OS picks").
 */
function resolvePort(): number {
  const port = Number.parseInt(process.env.PORT || '0', 10);
  if (Number.isNaN(port) || port < 0 || port > 65535) {
    console.error(`${ts()} host_exec FATAL: invalid PORT value: ${process.env.PORT}`);
    process.exit(1);
  }
  return port;
}

/** Start the worker. */
async function main(): Promise<void> {
  console.log(`${ts()} Starting ${SERVER_NAME} (platform ${process.platform})...`);

  const authToken = process.env.HOST_EXEC_AUTH_TOKEN;
  if (!authToken) {
    console.error(
      `${ts()} host_exec FATAL: HOST_EXEC_AUTH_TOKEN is required — host_exec must not run without authentication.`
    );
    process.exit(1);
  }
  const configPath = process.env.HOST_EXEC_CONFIG_PATH;
  if (!configPath) {
    console.error(
      `${ts()} host_exec FATAL: HOST_EXEC_CONFIG_PATH is required (path to the per-project whitelist snapshot).`
    );
    process.exit(1);
  }

  // Read the whitelist at startup to build the tools. A parse error is fatal
  // (the spawner writes it from a validated config) — refuse to start rather
  // than expose a half-baked tool set.
  let snapshot;
  try {
    snapshot = await readConfigSnapshot(configPath);
  } catch (e) {
    console.error(`${ts()} host_exec FATAL: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  const tools = buildTools(snapshot.commands, configPath);

  const server = createMCPServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    port: resolvePort(),
    tools,
    auth: { token: authToken },
  });

  const actualPort = await server.start();
  // Machine-readable port announcement on stdout — the spawner scans stdout
  // for this JSON object.
  process.stdout.write(JSON.stringify({ port: actualPort }) + '\n');
  console.log(
    `${ts()} ${SERVER_NAME} started on port ${actualPort} for project '${snapshot.projectDir}' ` +
      `(${tools.length} recipe${tools.length === 1 ? '' : 's'}, auth enforced)`
  );
}

main().catch((error) => {
  console.error(`${ts()} host_exec fatal error:`, error);
  process.exit(1);
});
