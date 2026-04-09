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

const HOST_GATEWAY_ALLOWLIST = new Set([
  'host.lima.internal',
  'host.docker.internal',
  'host.containers.internal',
  'host.speedwave.internal',
]);

/**
 * Validate that a worker URL matches canonical Speedwave internal endpoints.
 * Defense-in-depth: asserts that runtime provided a correct internal URL.
 *
 * Accepted patterns:
 * - Container workers: http://mcp-{name}:{port} (Docker internal DNS)
 * - Host gateway (OS worker): http://host.{lima,docker,containers,speedwave}.internal:{port}
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
  if (!CONTAINER_HOSTNAME_RE.test(hostname) && !HOST_GATEWAY_ALLOWLIST.has(hostname)) {
    return false;
  }

  if (parsed.pathname !== '/') return false;
  if (parsed.search !== '') return false;
  if (parsed.hash !== '') return false;
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
