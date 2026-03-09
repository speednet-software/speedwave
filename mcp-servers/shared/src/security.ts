/**
 * MCP Security Module
 * Defense-in-depth security for MCP servers
 *
 * Security Principles:
 * 1. Validate ALL inputs
 * 2. Never expose tokens
 *
 * Note: MCP servers run inside an isolated Docker network without host-exposed
 * ports. No Origin/CORS validation is needed at the application layer.
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
      throw new Error(`Token file not found: ${tokenPath}`);
    } else if (code === 'EACCES') {
      throw new Error(`Permission denied reading token file: ${tokenPath}`);
    } else if (code === 'EISDIR') {
      throw new Error(`Token path is a directory, not a file: ${tokenPath}`);
    } else {
      // Other errors (EIO, EMFILE, etc.)
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read token file: ${tokenPath} (${message})`);
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
