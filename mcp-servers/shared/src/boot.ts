/**
 * Declarative worker boot — SSOT for every built-in worker's `main()`.
 * @module shared/boot
 */

import { createMCPServer, type MCPServerOptions } from './server.js';
import { ts } from './logger.js';
import { notConfiguredMessage } from './errors.js';
import { retryAsync } from './retry.js';

/** What to do when the client is absent / not configured. */
export type NotConfiguredPolicy = 'warn' | 'fail';

/** Options for {@link bootWorker}. */
export interface BootWorkerOptions<C> {
  /** Server name (e.g. `mcp-github`). */
  serverName: string;
  /** Server version string. */
  version: string;
  /** Default port when `PORT` is unset (default `'3000'`; os/host-side use `'0'`). */
  defaultPort?: string;
  /** Display name for "not configured" messages (e.g. `GitHub`). Defaults to `serverName`. */
  displayName?: string;
  /** Env var holding the required Bearer token. When unset, no auth gate is applied. */
  authTokenEnv?: string;
  /** Bind host. Containers pass `'0.0.0.0'`; host-side workers omit it. */
  host?: string;
  /** Initialize the service client. Omit for credential-free workers (office). */
  initClient?: () => Promise<C | null>;
  /** Retry config for `initClient` (default 3 retries, 2 s base). */
  retry?: { maxRetries: number; baseDelayMs: number };
  /** Whether a (possibly non-null) client counts as configured. Default: `client != null`. */
  isConfigured?: (client: C | null) => boolean;
  /** Behaviour when not configured: warn-and-continue or fail-fast. Default `'warn'`. */
  onNotConfigured?: NotConfiguredPolicy;
  /** Build the tool definitions from the (possibly null) client. */
  makeTools: (client: C | null) => MCPServerOptions['tools'];
  /** Build the health check from the (possibly null) client. Omit for none. */
  makeHealthCheck?: (client: C | null, configured: boolean) => MCPServerOptions['healthCheck'];
}

/**
 * Boot a worker and return the actual listening port.
 * @template C - Service client type.
 * @param opts - Declarative boot configuration.
 */
export async function bootWorker<C>(opts: BootWorkerOptions<C>): Promise<number> {
  const {
    serverName,
    version,
    defaultPort = '3000',
    displayName = serverName,
    authTokenEnv,
    host,
    initClient,
    retry = { maxRetries: 3, baseDelayMs: 2000 },
    isConfigured = (c) => c != null,
    onNotConfigured = 'warn',
    makeTools,
    makeHealthCheck,
  } = opts;

  console.log(`${ts()} 🚀 Starting ${serverName}...`);

  const port = parseInt(process.env.PORT || defaultPort, 10);
  if (Number.isNaN(port) || port < 0 || port > 65535) {
    console.error(`${ts()} ${serverName} FATAL: invalid PORT value`);
    process.exit(1);
  }

  let authToken: string | undefined;
  if (authTokenEnv) {
    authToken = process.env[authTokenEnv];
    if (!authToken) {
      console.error(
        `${ts()} FATAL: ${authTokenEnv} is required. ` +
          `${serverName} must not run without authentication.`
      );
      process.exit(1);
    }
  }

  let client: C | null = null;
  if (initClient) {
    client = await retryAsync(initClient, {
      maxRetries: retry.maxRetries,
      baseDelayMs: retry.baseDelayMs,
      label: `${displayName} client init`,
    });
  }

  const configured = initClient ? isConfigured(client) : true;
  if (initClient && !configured) {
    if (onNotConfigured === 'fail') {
      console.error(`${ts()} ❌ ${notConfiguredMessage(displayName)}`);
      process.exit(1);
    }
    // The two-line "not configured" warning, formerly duplicated 18×.
    console.warn(`${ts()} ⚠️  ${notConfiguredMessage(displayName)}`);
    console.warn(`${ts()}    Server will start but tools will return errors until configured.`);
  } else if (initClient) {
    console.log(`${ts()} ✅ ${displayName} client initialized`);
  }

  const server = createMCPServer({
    name: serverName,
    version,
    port,
    ...(host !== undefined ? { host } : {}),
    tools: makeTools(client),
    ...(authToken ? { auth: { token: authToken } } : {}),
    ...(makeHealthCheck ? { healthCheck: makeHealthCheck(client, configured) } : {}),
  });

  const actualPort = await server.start();
  process.stdout.write(JSON.stringify({ port: actualPort }) + '\n');
  console.log(`${ts()} ✅ ${serverName} started on port ${actualPort} (auth enforced)`);
  return actualPort;
}
