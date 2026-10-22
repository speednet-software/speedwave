/**
 * Guard configuration from the container environment: server identity, policy file and upstream mode.
 * @module custom-guard/config
 */

import { validateWorkerUrl, type PathStyle } from '@speedwave/mcp-shared';

/** Where the guarded server runs: an npm package in a sibling container, or an HTTP server on the host behind the Desktop relay. */
export type GuardMode = 'npm' | 'host';

/** Upstream of an npm-mode guard: the launcher endpoint in the server container. */
export interface NpmUpstreamConfig {
  /** Discriminant. */
  mode: 'npm';
  /** Launcher URL (`http://mcp-custom-<name>-up:3000/`). */
  url: string;
  /** Bearer the launcher requires. */
  authToken: string;
}

/** Upstream of a host-mode guard: relay endpoint files plus the project directory for path mapping. */
export interface HostUpstreamConfig {
  /** Discriminant. */
  mode: 'host';
  /** Mounted directory holding `endpoint.json` and `token`. */
  relayDir: string;
  /** Raw project directory on the host. */
  hostDir: string;
  /** Path flavour of `hostDir`. */
  pathStyle: PathStyle;
}

/** Resolved guard configuration. */
export interface GuardConfig {
  /** Server name chosen by the user (`figma`). */
  serverName: string;
  /** Hub service id (`custom-figma`). */
  serviceId: string;
  /** Env var holding the hub bearer. */
  authTokenEnv: string;
  /** Policy file path (only this exact file is ever read). */
  policyFile: string;
  /** Upstream settings for the mode. */
  upstream: NpmUpstreamConfig | HostUpstreamConfig;
}

/** Raised for configuration that must stop the guard before it starts. */
export class GuardConfigError extends Error {
  /**
   * Create the error.
   * @param message - What is wrong (never a secret value).
   */
  constructor(message: string) {
    super(message);
    this.name = 'GuardConfigError';
  }
}

/** Hub service id prefix of every custom MCP server. */
export const CUSTOM_SERVICE_PREFIX = 'custom-';

/** Default policy file inside the `/policy` mount. */
export const DEFAULT_POLICY_FILE = '/policy/policy.json';

/** Default relay directory inside the `/secrets/relay` mount. */
export const DEFAULT_RELAY_DIR = '/secrets/relay';

const SERVER_NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;
const RESERVED_SUFFIXES = ['-up', '-egress'];
const PATH_STYLES: ReadonlySet<string> = new Set(['posix', 'windows', 'unc']);

/**
 * Whether a server name is valid: `^[a-z][a-z0-9-]{0,30}$`, not ending in a reserved container-role suffix.
 * @param name - Candidate server name.
 */
export function isValidServerName(name: string): boolean {
  return SERVER_NAME_RE.test(name) && !RESERVED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * Env var name of a worker bearer, the shape `compose/workers.rs` renders: `MCP_<SERVICE_ID>_AUTH_TOKEN`, upper-cased, `-` as `_`.
 * @param serviceId - Hub service id.
 */
export function authTokenEnvFor(serviceId: string): string {
  return `MCP_${serviceId.toUpperCase().replace(/-/g, '_')}_AUTH_TOKEN`;
}

/**
 * A required non-empty env value.
 * @param env - Environment.
 * @param name - Variable name.
 */
function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new GuardConfigError(`${name} is required`);
  }
  return value;
}

/**
 * Read and validate the guard configuration.
 * @param env - Environment (normally `process.env`).
 */
export function readGuardConfig(env: Record<string, string | undefined>): GuardConfig {
  const serverName = required(env, 'SPW_CUSTOM_SERVER');
  if (!isValidServerName(serverName)) {
    throw new GuardConfigError(
      'SPW_CUSTOM_SERVER must match ^[a-z][a-z0-9-]{0,30}$ and must not end in -up or -egress'
    );
  }
  const serviceId = `${CUSTOM_SERVICE_PREFIX}${serverName}`;
  const policyFile = env.POLICY_FILE?.trim() || DEFAULT_POLICY_FILE;
  const mode = required(env, 'SPW_CUSTOM_MODE');

  if (mode === 'npm') {
    const url = required(env, 'SPW_UPSTREAM_URL');
    if (!validateWorkerUrl(url)) {
      throw new GuardConfigError('SPW_UPSTREAM_URL must be an http://<container>:<port>/ URL');
    }
    return {
      serverName,
      serviceId,
      authTokenEnv: authTokenEnvFor(serviceId),
      policyFile,
      upstream: { mode, url, authToken: required(env, 'SPW_UPSTREAM_AUTH_TOKEN') },
    };
  }

  if (mode === 'host') {
    const pathStyle = required(env, 'SPW_HOST_PATH_STYLE');
    if (!PATH_STYLES.has(pathStyle)) {
      throw new GuardConfigError('SPW_HOST_PATH_STYLE must be posix, windows or unc');
    }
    return {
      serverName,
      serviceId,
      authTokenEnv: authTokenEnvFor(serviceId),
      policyFile,
      upstream: {
        mode,
        relayDir: env.SPW_RELAY_DIR?.trim() || DEFAULT_RELAY_DIR,
        hostDir: required(env, 'SPW_HOST_PROJECT_DIR'),
        pathStyle: pathStyle as PathStyle,
      },
    };
  }

  throw new GuardConfigError('SPW_CUSTOM_MODE must be npm or host');
}
