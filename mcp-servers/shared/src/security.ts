/**
 * MCP Security Module
 * Defense-in-depth security for MCP servers
 *
 * Security Principles:
 * 1. Validate ALL inputs
 * 2. Never expose tokens
 * 3. Validate Origin headers per MCP Streamable HTTP spec
 */
import fs from 'fs/promises';
import path from 'node:path';

/**
 * Directory the orchestrator mounts service credentials into (read-only).
 * SSOT for the `TOKENS_DIR`-or-`/tokens` literal repeated across every worker.
 * @returns `process.env.TOKENS_DIR` when set and non-empty, else `/tokens`.
 */
export function tokensDir(): string {
  const dir = process.env.TOKENS_DIR;
  return dir && dir.length > 0 ? dir : '/tokens';
}

/**
 * Load a credential file by name from {@link tokensDir}. Thin wrapper over
 * {@link loadToken} so workers stop hand-rolling `path.join(TOKENS_DIR, name)`.
 * Errors are errno-differentiated by {@link loadToken} (cause forwarded).
 * @param name - File name under the tokens directory (e.g. `bot_token`).
 * @returns Trimmed file contents.
 * @throws {Error} With errno cause forwarded (ENOENT/EACCES/EISDIR/…).
 */
export async function loadTokenFile(name: string): Promise<string> {
  return loadToken(path.join(tokensDir(), name));
}

/**
 * Load token from file (used for secrets management)
 * Tokens are mounted read-only from host to /tokens/ directory
 * @param tokenPath - Path to token file
 * @returns Token string (trimmed)
 * @throws {Error} Error with specific details about the failure
 */
export async function loadToken(tokenPath: string): Promise<string> {
  try {
    const token = await fs.readFile(tokenPath, 'utf-8');
    return token.trim();
  } catch (error) {
    // Differentiate error types for better debugging
    const code = (error as NodeJS.ErrnoException).code;

    // Forward `cause` so callers that need the original errno (e.g.
    // mcp-context7's optional-key fallback) can read `(e.cause as
    // ErrnoException).code` without falling back to message matching.
    if (code === 'ENOENT') {
      throw new Error(`Token file not found: ${tokenPath}`, { cause: error });
    } else if (code === 'EACCES') {
      throw new Error(`Permission denied reading token file: ${tokenPath}`, { cause: error });
    } else if (code === 'EISDIR') {
      throw new Error(`Token path is a directory, not a file: ${tokenPath}`, { cause: error });
    } else {
      // Other errors (EIO, EMFILE, etc.)
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read token file: ${tokenPath} (${message})`, { cause: error });
    }
  }
}

/**
 * Core allowlist of env var names safe to pass to child processes — the
 * identical 14-key set shared by every worker that spawns a child. Workers
 * with extra needs (host_exec build tooling) spread this and append.
 * Anything carrying a secret (`MCP_*_AUTH_TOKEN`, API keys) is never here.
 */
export const BASE_SAFE_ENV_KEYS: readonly string[] = [
  // Process / shell environment
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
  // macOS: required by Swift runtime / Xcode toolchain
  'DEVELOPER_DIR',
  'SDKROOT',
  '__CF_USER_TEXT_ENCODING',
];

/**
 * Validate JSON-RPC message structure
 * Prevents injection attacks and malformed requests
 * @param body Request body
 * @returns true if valid JSON-RPC message
 */
export function validateJSONRPCMessage(body: unknown): boolean {
  // Must have jsonrpc field
  if (!body || typeof body !== 'object') {
    return false;
  }

  const message = body as Record<string, unknown>;

  // Must be JSON-RPC 2.0
  if (message.jsonrpc !== '2.0') {
    return false;
  }

  // Must have either method (request/notification) or result/error (response)
  const hasMethod = typeof message.method === 'string' && message.method.length <= 200;
  const hasResult = 'result' in message || 'error' in message;

  if (!hasMethod && !hasResult) {
    return false;
  }

  if ('params' in message && !validateParams(message.params)) {
    return false;
  }

  // If it's a request (has method), must have id
  if (hasMethod && !('id' in message)) {
    // It's a notification - valid
    return true;
  }

  // If it has id, must be string or number
  if ('id' in message) {
    const idType = typeof message.id;
    if (idType !== 'string' && idType !== 'number') {
      return false;
    }
  }

  return true;
}

/**
 * Validate JSON-RPC params structure
 * Params must be an object or array (per JSON-RPC 2.0 spec), or absent
 * @param params - The params value to validate
 * @returns true if valid params (object, array, or undefined)
 */
export function validateParams(
  params: unknown
): params is Record<string, unknown> | unknown[] | undefined {
  if (params === undefined) return true;
  return params !== null && typeof params === 'object';
}

/**
 * Validate session ID format
 * Session IDs must be UUIDs (crypto.randomUUID())
 * @param sessionId Session ID to validate
 * @returns true if valid
 */
export function validateSessionId(sessionId: string): boolean {
  // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(sessionId);
}

/**
 * Validate tool name to prevent command injection
 * Tool names must be alphanumeric with underscores only
 * @param toolName Tool name to validate
 * @returns true if valid
 */
export function validateToolName(toolName: string): boolean {
  // Only allow: letters, numbers, underscore, hyphen
  const toolNameRegex = /^[a-zA-Z0-9_-]+$/;
  return toolNameRegex.test(toolName) && toolName.length > 0 && toolName.length < 100;
}

const CONTAINER_HOSTNAME_RE = /^mcp-[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

// SSOT mirror — synchronized with crates/speedwave-runtime/src/consts.rs::HOST_GATEWAY_ALIAS
// via Rust regression test `host_gateway_alias_matches_mcp_shared_ts`.
export const HOST_GATEWAY_ALIAS = 'host.docker.internal';

/**
 * Validate that a worker URL matches canonical Speedwave internal endpoints.
 * Defense-in-depth: asserts that runtime provided a correct internal URL.
 *
 * Accepted patterns:
 * - Container workers: http://mcp-{name}:{port} (Docker internal DNS)
 * - Host gateway (OS worker): http://host.docker.internal:{port}
 *
 * Rejects everything else (external hosts, IPs, wrong protocols, paths, query strings).
 * @param url - URL string to validate
 * @returns true if the URL matches a canonical worker endpoint
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

  // URL constructor lowercases hostname, so also check the original string
  // to reject uppercase input (Docker DNS is lowercase)
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
  // The password sub-condition is defense-in-depth: the raw-hostname check above already
  // rejects any URL with credentials (they shift the colon position). The branch is kept
  // for correctness but is unreachable in practice — hence c8 ignore on the || right side.
  /* c8 ignore next */
  if (parsed.username !== '' || parsed.password !== '') return false;

  return true;
}

/**
 * Validate Origin header per MCP Streamable HTTP spec.
 * Missing Origin (non-browser clients) is allowed.
 * Present Origin must be in allowedOrigins list.
 * @param origin - Origin header value (undefined if absent)
 * @param allowedOrigins - List of allowed origin strings
 * @returns true if the origin is acceptable
 */
export function validateOrigin(origin: string | undefined, allowedOrigins?: string[]): boolean {
  if (origin == null) return true;
  if (allowedOrigins && allowedOrigins.length > 0) return allowedOrigins.includes(origin);
  return false;
}
