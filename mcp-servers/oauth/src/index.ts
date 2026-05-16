/**
 * `oauth` MCP worker — host-side, per-project (ADR-060).
 *
 * Holds OAuth refresh tokens, client_id, tenant_id for each configured
 * OAuth-using service in the project. Exposes `refresh` and `forget` tools to
 * authenticated consumers (today: SharePoint). NOT visible to Claude — not in
 * ENABLED_SERVICES, the hub has no bearer for it.
 *
 * Env inputs (set by the Rust supervisor `oauth_process.rs`):
 *   PORT             — listening port (0 = OS picks)
 *   OAUTH_STATE_DIR  — per-project state dir `~/.speedwave/oauth/<project>/`
 *   OAUTH_LOG_FILE   — audit log path (append-only, 0o600)
 *   OAUTH_PROJECT    — project id (embedded in audit log entries)
 *   OAUTH_SUPERVISOR_TOKEN — primary bearer (for supervisor health probes)
 *
 * Consumer bearers are read at startup from `<OAUTH_STATE_DIR>/.bearer-map.json`.
 */
import { join } from 'node:path';
import { createMCPServer, ts } from '@speedwave/mcp-shared';
import { loadBearerMap } from './oauth-state.js';
import { buildTools } from './tools.js';

const SERVER_NAME = 'oauth';
const SERVER_VERSION = '1.0.0';

function resolvePort(): number {
  const port = Number.parseInt(process.env.PORT || '0', 10);
  if (Number.isNaN(port) || port < 0 || port > 65535) {
    console.error(`${ts()} oauth FATAL: invalid PORT value: ${process.env.PORT}`);
    process.exit(1);
  }
  return port;
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value || !value.trim()) {
    console.error(`${ts()} oauth FATAL: ${key} is required`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  console.log(`${ts()} Starting ${SERVER_NAME} (platform ${process.platform})...`);

  const stateDir = requireEnv('OAUTH_STATE_DIR');
  const auditLogPath = process.env.OAUTH_LOG_FILE ?? join(stateDir, 'audit.log');
  const project = requireEnv('OAUTH_PROJECT');
  const supervisorToken = requireEnv('OAUTH_SUPERVISOR_TOKEN');
  // Fail-fast: the Rust supervisor always sets OAUTH_TOKENS_BASE; a missing
  // value would have access tokens land in a relative `<project>/<service>/
  // access_token` path that nothing else reads.
  const tokensBase = requireEnv('OAUTH_TOKENS_BASE');

  // Load consumer bearers — bearer → service id.
  const bearerMap = await loadBearerMap(stateDir);

  // ADR-060 §"Threat model" claims the refresh rate limit is configurable
  // via OAUTH_REFRESH_RATE_LIMIT_SECONDS. Honour that contract here.
  const rateLimitOverride = process.env.OAUTH_REFRESH_RATE_LIMIT_SECONDS;
  const rateLimitSeconds = rateLimitOverride ? Number.parseInt(rateLimitOverride, 10) : undefined;
  if (
    rateLimitOverride !== undefined &&
    (Number.isNaN(rateLimitSeconds!) || rateLimitSeconds! < 0)
  ) {
    console.error(
      `${ts()} oauth FATAL: invalid OAUTH_REFRESH_RATE_LIMIT_SECONDS: ${rateLimitOverride}`
    );
    process.exit(1);
  }

  const tools = buildTools({
    stateDir,
    project,
    auditLogPath,
    accessTokenPathFor: (service) => join(tokensBase, project, service, 'access_token'),
    rateLimitSeconds,
  });

  const server = createMCPServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    port: resolvePort(),
    tools,
    auth: {
      token: supervisorToken,
      callerTokens: bearerMap,
    },
  });

  const actualPort = await server.start();
  process.stdout.write(JSON.stringify({ port: actualPort }) + '\n');
  console.log(
    `${ts()} ${SERVER_NAME} started on port ${actualPort} for project '${project}' (${Object.keys(bearerMap).length} consumer${Object.keys(bearerMap).length === 1 ? '' : 's'} configured)`
  );
}

main().catch((error) => {
  console.error(`${ts()} oauth fatal error:`, error);
  process.exit(1);
});
