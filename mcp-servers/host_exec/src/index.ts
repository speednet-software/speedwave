/**
 * `host_exec` MCP worker — runs user-whitelisted project-toolchain commands on
 * the HOST, in the project directory, with no shell, with per-recipe
 * confirmation. **Per-project**: one worker process per project (each on its
 * own `127.0.0.1` port), spawned by the Tauri backend; the project's
 * `mcp-hub` reaches it via `WORKER_HOST_EXEC_URL` (gateway routing, ADR-010).
 * Not a container.
 *
 * Inputs (env, set by the Tauri parent):
 * - `PORT` — `0` lets the OS pick a free port (announced on stdout).
 * - `HOST_EXEC_AUTH_TOKEN` — Bearer token; required (the worker refuses to run
 *   without it).
 * - `HOST_EXEC_CONFIG_PATH` — path to the validated per-project whitelist
 *   snapshot (`<data_dir>/host-exec/<project>/config.json`). Read at startup to
 *   build the tools, and re-read on every tool call so a removed/disabled
 *   recipe fails closed.
 * - `HOST_EXEC_LOG_FILE` — per-project audit log path.
 * - fd 3 — extra pipe for confirm-requests (worker → Tauri); replies arrive on
 *   stdin. If absent, confirmations time out (fail closed).
 *
 * See ADR-054.
 * @module host_exec
 */

import { createMCPServer, ts } from '@speedwave/mcp-shared';
import { readConfigSnapshot } from './config.js';
import { openFd3, realConfirmChannel } from './confirm.js';
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

  // Read the whitelist at startup to build the tools. If it is malformed, that
  // is fatal (the Tauri side writes it from a validated config, so a parse
  // error means something is badly wrong) — better to refuse to start than to
  // expose a half-baked tool set.
  let snapshot;
  try {
    snapshot = await readConfigSnapshot(configPath);
  } catch (e) {
    console.error(`${ts()} host_exec FATAL: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  const transport = realConfirmChannel(openFd3(), process.stdin);
  const tools = buildTools(snapshot.commands, configPath, transport);

  const server = createMCPServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    port: resolvePort(),
    tools,
    auth: { token: authToken },
  });

  const actualPort = await server.start();
  // Machine-readable port announcement on stdout — the Tauri parent scans
  // stdout for this JSON object. (Confirm-requests go to fd 3, not stdout, so
  // they never collide with this line.)
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
