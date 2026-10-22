/**
 * Streamable HTTP front for a stdio MCP server: bearer-gated POST endpoint, credentials from token files into the child's environment only, process lifetime tied to the child.
 * @module custom-launcher/launcher
 */

import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { StdioBridge, BridgeAbortedError, type JsonRpcMessage } from './stdio-bridge.js';

/** The fixed command the launcher runs. */
export interface LauncherEntry {
  /** Executable (no shell). */
  command: string;
  /** Arguments passed verbatim. */
  args: string[];
}

/** Resolved launcher configuration. */
export interface LauncherConfig {
  /** Command to run. */
  entry: LauncherEntry;
  /** Bearer token every request except `/health` must carry. */
  authToken: string;
  /** TCP port (0 picks a free one). */
  port: number;
  /** Bind address. */
  host: string;
  /** Complete environment of the child. */
  childEnv: Record<string, string>;
  /** Upper bound on a request body, in bytes. */
  maxBodyBytes: number;
}

/** A running launcher. */
export interface LauncherHandle {
  /** Bound port. */
  port: number;
  /** Stop the HTTP server and the child. */
  close(): Promise<void>;
}

/** Raised for configuration that must stop the launcher before it starts. */
export class LauncherConfigError extends Error {
  /**
   * Create the error.
   * @param message - What is wrong (never a secret value).
   */
  constructor(message: string) {
    super(message);
    this.name = 'LauncherConfigError';
  }
}

/** Environment variable names a token file may never set; Speedwave sets proxy env itself. */
export const FORBIDDEN_ENV_KEYS: readonly string[] = Object.freeze([
  'NODE_OPTIONS',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'NODE_USE_ENV_PROXY',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_EXTRA_CA_CERTS',
]);

/** Environment variable prefixes a token file may never set. */
export const FORBIDDEN_ENV_PREFIXES: readonly string[] = Object.freeze([
  'NPM_CONFIG_',
  'PIP_',
  'SPW_',
]);

/** Launcher environment passed through to the child; everything else (the bearer included) stays with the launcher. */
export const CHILD_ENV_PASSTHROUGH: readonly string[] = Object.freeze([
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'NODE_ENV',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'all_proxy',
  'no_proxy',
  'NODE_USE_ENV_PROXY',
]);

/** Default path of the entry file baked into the image. */
export const DEFAULT_ENTRY_PATH = '/opt/spw/entry.json';

/** Default upper bound on a request body. */
export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

const MIN_TOKEN_LENGTH = 16;
const MAX_ENTRY_BYTES = 64 * 1024;
const MAX_TOKEN_FILE_BYTES = 64 * 1024;
const MAX_ARGS = 256;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const INITIALIZED_NOTIFICATION = 'notifications/initialized';

/**
 * Whether a value is a non-null, non-array object.
 * @param value - Value to test.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a string is non-empty, bounded and free of NUL bytes.
 * @param value - Candidate.
 * @param max - Maximum length.
 */
function isSafeString(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
  );
}

/**
 * Read and validate the entry file (`{command, args}` and nothing else).
 * @param entryPath - Path of the JSON entry file.
 */
export function readEntry(entryPath: string): LauncherEntry {
  let raw: string;
  try {
    if (statSync(entryPath).size > MAX_ENTRY_BYTES) {
      throw new LauncherConfigError(
        `entry file ${entryPath} is larger than ${MAX_ENTRY_BYTES} bytes`
      );
    }
    raw = readFileSync(entryPath, 'utf8');
  } catch (error) {
    if (error instanceof LauncherConfigError) throw error;
    throw new LauncherConfigError(`cannot read entry file ${entryPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LauncherConfigError(`entry file ${entryPath} is not valid JSON`);
  }
  if (!isRecord(parsed)) throw new LauncherConfigError('entry must be a JSON object');
  const unknownKeys = Object.keys(parsed).filter((key) => key !== 'command' && key !== 'args');
  if (unknownKeys.length > 0) {
    throw new LauncherConfigError(`entry has unknown keys: ${unknownKeys.join(', ')}`);
  }
  const { command, args } = parsed;
  if (!isSafeString(command, 4096)) {
    throw new LauncherConfigError('entry.command must be a non-empty string without NUL bytes');
  }
  if (
    !Array.isArray(args) ||
    args.length > MAX_ARGS ||
    !args.every((arg) => typeof arg === 'string' && arg.length <= 4096 && !arg.includes('\0'))
  ) {
    throw new LauncherConfigError(
      `entry.args must be an array of at most ${MAX_ARGS} strings without NUL bytes`
    );
  }
  return { command, args: args as string[] };
}

/**
 * Whether a token file name would set an environment variable the launcher never lets a credential set.
 * @param name - Environment variable name.
 */
export function isForbiddenEnvKey(name: string): boolean {
  return (
    FORBIDDEN_ENV_KEYS.includes(name) || FORBIDDEN_ENV_PREFIXES.some((p) => name.startsWith(p))
  );
}

/**
 * Read `<dir>/<KEY>` credential files into a map; names that are not env-shaped are skipped, forbidden names stop the launcher. Values are never logged.
 * @param dir - Token directory (missing directory = no credentials).
 */
export function readTokenEnv(dir: string): Record<string, string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new LauncherConfigError(`cannot read token directory ${dir}`);
  }
  const tokens: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.isFile() || !ENV_NAME_RE.test(entry.name)) continue;
    if (isForbiddenEnvKey(entry.name)) {
      throw new LauncherConfigError(
        `token file ${entry.name} would set a forbidden environment variable`
      );
    }
    const file = path.join(dir, entry.name);
    if (statSync(file).size > MAX_TOKEN_FILE_BYTES) {
      throw new LauncherConfigError(
        `token file ${entry.name} is larger than ${MAX_TOKEN_FILE_BYTES} bytes`
      );
    }
    const value = readFileSync(file, 'utf8').trim();
    if (value.includes('\0')) {
      throw new LauncherConfigError(`token file ${entry.name} contains a NUL byte`);
    }
    tokens[entry.name] = value;
  }
  return tokens;
}

/**
 * The child's environment: the passthrough subset of the launcher's own environment, then the credentials.
 * @param parentEnv - Launcher environment.
 * @param tokens - Credentials from token files.
 */
export function buildChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  tokens: Record<string, string>
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of CHILD_ENV_PASSTHROUGH) {
    const value = parentEnv[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...tokens };
}

/**
 * Resolve the launcher configuration from its environment; throws {@link LauncherConfigError} on anything unsafe.
 * @param env - Launcher environment.
 */
export function loadConfig(env: NodeJS.ProcessEnv): LauncherConfig {
  const authToken = env.SPW_LAUNCHER_AUTH_TOKEN ?? '';
  if (authToken.trim().length < MIN_TOKEN_LENGTH) {
    throw new LauncherConfigError(
      `SPW_LAUNCHER_AUTH_TOKEN is required (at least ${MIN_TOKEN_LENGTH} characters); the launcher never runs without authentication`
    );
  }
  const port = Number(env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new LauncherConfigError('PORT must be an integer in 0..65535');
  }
  const entry = readEntry(env.SPW_LAUNCHER_ENTRY || DEFAULT_ENTRY_PATH);
  const tokens = readTokenEnv(env.TOKENS_DIR || '/tokens');
  return {
    entry,
    authToken,
    port,
    host: env.MCP_LISTEN_HOST || '0.0.0.0',
    childEnv: buildChildEnv(env, tokens),
    maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
  };
}

/**
 * Constant-time string comparison over SHA-256 digests (length-independent).
 * @param provided - Value from the request.
 * @param expected - Configured secret.
 */
function safeEqual(provided: string, expected: string): boolean {
  const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

/**
 * Send a JSON body.
 * @param res - Response.
 * @param status - HTTP status.
 * @param body - JSON-serializable body.
 */
function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * Send a JSON-RPC error with an HTTP status.
 * @param res - Response.
 * @param status - HTTP status.
 * @param id - Request id, if known.
 * @param code - JSON-RPC error code.
 * @param message - Error message.
 */
function sendRpcError(
  res: http.ServerResponse,
  status: number,
  id: string | number | null,
  code: number,
  message: string
): void {
  sendJson(res, status, { jsonrpc: '2.0', id, error: { code, message } });
}

/**
 * Read a request body up to `maxBytes`; resolves null after answering 413.
 * @param req - Request.
 * @param res - Response.
 * @param maxBytes - Byte budget.
 */
function readBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  maxBytes: number
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? '0');
    const tooLarge = () => {
      res.setHeader('Connection', 'close');
      sendJson(res, 413, { error: 'Payload Too Large' });
      req.destroy();
      resolve(null);
    };
    if (declared > maxBytes) {
      tooLarge();
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.removeAllListeners('data');
        req.removeAllListeners('end');
        tooLarge();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Start the child and the HTTP endpoint.
 * @param config - Resolved configuration.
 * @param onChildExit - Called once when the child exits.
 */
export async function startLauncher(
  config: LauncherConfig,
  onChildExit: (code: number | null, signal: NodeJS.Signals | null) => void
): Promise<LauncherHandle> {
  const bridge = new StdioBridge({
    command: config.entry.command,
    args: config.entry.args,
    env: config.childEnv,
    onExit: onChildExit,
  });
  let initializeResult: Promise<JsonRpcMessage> | null = null;
  let initializedForwarded = false;

  async function initialize(message: JsonRpcMessage): Promise<JsonRpcMessage> {
    initializeResult ??= bridge.request(message).then((response) => {
      if (!('result' in response)) initializeResult = null;
      return response;
    });
    const response = await initializeResult;
    return { ...response, id: message.id };
  }

  async function dispatch(message: JsonRpcMessage, res: http.ServerResponse): Promise<void> {
    if (typeof message.method !== 'string') {
      res.writeHead(202).end();
      return;
    }
    if (!('id' in message)) {
      if (message.method !== INITIALIZED_NOTIFICATION || !initializedForwarded) {
        initializedForwarded ||= message.method === INITIALIZED_NOTIFICATION;
        bridge.notify(message);
      }
      res.writeHead(202).end();
      return;
    }
    const id = message.id;
    if (typeof id !== 'string' && typeof id !== 'number') {
      sendRpcError(res, 400, null, -32600, 'Invalid Request: id must be a string or number');
      return;
    }
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    try {
      const response =
        message.method === 'initialize'
          ? await initialize(message)
          : await bridge.request(message, abort.signal);
      sendJson(res, 200, response);
    } catch (error) {
      if (error instanceof BridgeAbortedError) return;
      sendRpcError(res, 503, id, -32603, 'MCP server process is not running');
    }
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const route = (req.url ?? '/').split('?')[0];
    if (route === '/health' && req.method === 'GET') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }
    const header = req.headers.authorization ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!provided || !safeEqual(provided, config.authToken)) {
      console.warn(`authentication denied for ${req.method} request`);
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }
    if (req.headers.origin !== undefined) {
      sendJson(res, 403, { error: 'Forbidden: origin not allowed' });
      return;
    }
    if (route !== '/') {
      sendJson(res, 404, { error: 'Not Found' });
      return;
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    if (!(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) {
      sendJson(res, 415, { error: 'Unsupported Media Type' });
      return;
    }
    const body = await readBody(req, res, config.maxBodyBytes);
    if (body === null) return;
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      sendRpcError(res, 400, null, -32700, 'Parse error');
      return;
    }
    if (Array.isArray(message)) {
      sendRpcError(res, 400, null, -32600, 'Invalid Request: batches are not supported');
      return;
    }
    if (!isRecord(message) || message.jsonrpc !== '2.0') {
      sendRpcError(res, 400, null, -32600, 'Invalid Request');
      return;
    }
    await dispatch(message, res);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error(`request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) sendRpcError(res, 500, null, -32603, 'Internal error');
      else res.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        bridge.kill();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * Launcher entry point: load config, start, and exit non-zero when the child dies.
 * @param env - Launcher environment.
 * @param exit - Process exit function.
 * @param signals - Source of SIGTERM/SIGINT (the process by default).
 */
export async function main(
  env: NodeJS.ProcessEnv,
  exit: (code: number) => void,
  signals: Pick<NodeJS.EventEmitter, 'once'> = process
): Promise<LauncherHandle | null> {
  let config: LauncherConfig;
  try {
    config = loadConfig(env);
  } catch (error) {
    console.error(`custom MCP launcher cannot start: ${(error as Error).message}`);
    exit(1);
    return null;
  }
  let stopping = false;
  try {
    const handle = await startLauncher(config, (code, signal) => {
      console.error(
        `MCP server process exited (code ${code ?? 'none'}, signal ${signal ?? 'none'})`
      );
      exit(stopping ? 0 : code !== null && code !== 0 ? code : 1);
    });
    console.log(`custom MCP launcher listening on ${config.host}:${handle.port}`);
    const stop = () => {
      stopping = true;
      void handle.close();
    };
    signals.once('SIGTERM', stop);
    signals.once('SIGINT', stop);
    return handle;
  } catch (error) {
    console.error(`custom MCP launcher cannot start: ${(error as Error).message}`);
    exit(1);
    return null;
  }
}
