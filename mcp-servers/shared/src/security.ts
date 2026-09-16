/**
 * MCP Security Module: defense-in-depth for MCP servers.
 * Validate all inputs, never expose tokens, validate Origin headers per MCP Streamable HTTP spec.
 */
import fs from 'fs/promises';
import path from 'node:path';

/**
 * Directory the orchestrator mounts service credentials into (read-only); SSOT for the
 * `TOKENS_DIR`-or-`/tokens` literal repeated across every worker.
 */
export function tokensDir(): string {
  const dir = process.env.TOKENS_DIR;
  return dir && dir.length > 0 ? dir : '/tokens';
}

/**
 * Load a credential file by name from {@link tokensDir}, returning trimmed contents.
 * @param name - file name under the tokens directory (e.g. `bot_token`)
 * @throws {Error} with errno cause forwarded (ENOENT/EACCES/EISDIR/…).
 */
export async function loadTokenFile(name: string): Promise<string> {
  return loadToken(path.join(tokensDir(), name));
}

/**
 * Filename of the validated non-secret settings JSON under {@link tokensDir}. SSOT mirror of Rust
 * `consts::PLUGIN_SETTINGS_FILE` (cross-read test `plugin_settings_file_matches_mcp_shared_ts`).
 */
export const PLUGIN_SETTINGS_FILE = '_settings.json';

/**
 * Load a plugin's validated non-secret settings (`settings_schema` values) from
 * `<tokensDir>/_settings.json`; `{}` when absent. Never a secret channel — see {@link loadTokenFile}.
 * @throws {Error} on unreadable or non-JSON content.
 */
export async function loadPluginSettings<T = Record<string, unknown>>(): Promise<
  T | Record<string, never>
> {
  const settingsPath = path.join(tokensDir(), PLUGIN_SETTINGS_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(settingsPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read plugin settings file: ${settingsPath} (${message})`, {
      cause: error,
    });
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Plugin settings file is not valid JSON: ${settingsPath} (${message})`, {
      cause: error,
    });
  }
}

/**
 * Load a token from a file (mounted read-only from host to /tokens/), trimmed.
 * @param tokenPath - path to the token file
 * @throws {Error} with details specific to the failure mode (ENOENT/EACCES/EISDIR/other).
 */
export async function loadToken(tokenPath: string): Promise<string> {
  try {
    const token = await fs.readFile(tokenPath, 'utf-8');
    return token.trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === 'ENOENT') {
      throw new Error(`Token file not found: ${tokenPath}`, { cause: error });
    } else if (code === 'EACCES') {
      throw new Error(`Permission denied reading token file: ${tokenPath}`, { cause: error });
    } else if (code === 'EISDIR') {
      throw new Error(`Token path is a directory, not a file: ${tokenPath}`, { cause: error });
    } else {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read token file: ${tokenPath} (${message})`, { cause: error });
    }
  }
}

/**
 * Core allowlist of env var names safe to pass to child processes.
 * Never includes secret-carrying names (`MCP_*_AUTH_TOKEN`, API keys).
 */
export const BASE_SAFE_ENV_KEYS: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'DEVELOPER_DIR',
  'SDKROOT',
  '__CF_USER_TEXT_ENCODING',
];

/**
 * Validate JSON-RPC message structure; prevents injection attacks and malformed requests.
 * @param body - request body to validate
 */
export function validateJSONRPCMessage(body: unknown): boolean {
  if (!body || typeof body !== 'object') {
    return false;
  }

  const message = body as Record<string, unknown>;

  if (message.jsonrpc !== '2.0') {
    return false;
  }

  const hasMethod = typeof message.method === 'string' && message.method.length <= 200;
  const hasResult = 'result' in message || 'error' in message;

  if (!hasMethod && !hasResult) {
    return false;
  }

  if ('params' in message && !validateParams(message.params)) {
    return false;
  }

  if (hasMethod && !('id' in message)) {
    return true;
  }

  if ('id' in message) {
    const idType = typeof message.id;
    if (idType !== 'string' && idType !== 'number') {
      return false;
    }
  }

  return true;
}

/**
 * Validate JSON-RPC params: must be an object or array (per JSON-RPC 2.0 spec), or absent.
 * @param params - the params value to validate
 */
export function validateParams(
  params: unknown
): params is Record<string, unknown> | unknown[] | undefined {
  if (params === undefined) return true;
  return params !== null && typeof params === 'object';
}

/**
 * Validate session ID format; session IDs must be UUIDs (crypto.randomUUID()).
 * @param sessionId - session ID to validate
 */
export function validateSessionId(sessionId: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(sessionId);
}

/**
 * Validate tool name to prevent command injection; alphanumeric with underscores/hyphens only.
 * @param toolName - tool name to validate
 */
export function validateToolName(toolName: string): boolean {
  const toolNameRegex = /^[a-zA-Z0-9_-]+$/;
  return toolNameRegex.test(toolName) && toolName.length > 0 && toolName.length < 100;
}

const CONTAINER_HOSTNAME_RE = /^mcp-[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export const HOST_GATEWAY_ALIAS = 'host.docker.internal';

/**
 * Validate a worker URL matches canonical Speedwave internal endpoints: `http://mcp-{name}:{port}`
 * or `http://host.docker.internal:{port}`; rejects external hosts/IPs/protocols/paths/queries.
 * @param url - URL string to validate
 */
export function validateWorkerUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:') return false;

  if (parsed.port === '') return false;
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;

  const hostnameStart = url.indexOf('://') + 3;
  const hostnameEnd = url.indexOf(':', hostnameStart);
  const rawHostname = url.substring(hostnameStart, hostnameEnd);
  if (rawHostname !== parsed.hostname) return false;

  const hostname = parsed.hostname;
  if (!CONTAINER_HOSTNAME_RE.test(hostname) && hostname !== HOST_GATEWAY_ALIAS) {
    return false;
  }

  if (parsed.pathname !== '/') return false;
  if (parsed.search !== '') return false;
  if (parsed.hash !== '') return false;
  /* c8 ignore next */
  if (parsed.username !== '' || parsed.password !== '') return false;

  return true;
}

/**
 * Validate Origin header per MCP Streamable HTTP spec: missing Origin (non-browser clients)
 * is allowed; a present Origin must be in `allowedOrigins`.
 * @param origin - Origin header value (undefined if absent)
 * @param allowedOrigins - list of allowed origin strings
 */
export function validateOrigin(origin: string | undefined, allowedOrigins?: string[]): boolean {
  if (origin == null) return true;
  if (allowedOrigins && allowedOrigins.length > 0) return allowedOrigins.includes(origin);
  return false;
}
