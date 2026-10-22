/**
 * Minimal Streamable HTTP MCP client (initialize, tools/list, tools/call, ping) over hand-rolled JSON-RPC, for talking to an untrusted upstream server.
 * @module shared/mcp-client
 */

import { randomUUID } from 'node:crypto';
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from './types.js';
import { TIMEOUTS } from './timeouts.js';

/** Failure classes of {@link McpClient} calls. */
export type McpClientErrorKind = 'http' | 'rpc' | 'timeout' | 'too-large' | 'protocol' | 'network';

/** Error raised by {@link McpClient}; never carries a response body. */
export class McpClientError extends Error {
  /**
   * Create a client error.
   * @param kind - Failure class.
   * @param message - Human-readable summary.
   * @param details - HTTP status or JSON-RPC error code, when known.
   * @param details.status - HTTP status of the failed response.
   * @param details.rpcCode - JSON-RPC error code returned by the server.
   */
  constructor(
    readonly kind: McpClientErrorKind,
    message: string,
    readonly details: { status?: number; rpcCode?: number } = {}
  ) {
    super(message);
    this.name = 'McpClientError';
  }
}

/** Options for {@link McpClient}. */
export interface McpClientOptions {
  /** Server endpoint (POST target). */
  url: string;
  /** Bearer token sent as `Authorization: Bearer <token>`. */
  authToken?: string;
  /** Client identity sent in `initialize`. */
  clientInfo?: { name: string; version: string };
  /** Default per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Upper bound on one response body, in bytes. */
  maxResponseBytes?: number;
  /** Upper bound on `tools/list` pages. */
  maxListPages?: number;
  /** Fetch implementation (tests). */
  fetch?: typeof fetch;
}

/** Per-call options. */
export interface McpCallOptions {
  /** Timeout for this call in milliseconds. */
  timeoutMs?: number;
  /** Caller cancellation. */
  signal?: AbortSignal;
}

/** Outcome of the `initialize` handshake. */
export interface McpSessionInfo {
  /** Protocol version the server chose. */
  protocolVersion: string;
  /** `Mcp-Session-Id` assigned by the server, if any. */
  sessionId?: string;
}

/** Default upper bound on one response body. */
export const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** Default upper bound on `tools/list` pages. */
export const DEFAULT_MAX_LIST_PAGES = 50;

const SESSION_ID_RE = /^[\x21-\x7e]{1,256}$/;
const ERROR_BODY_PEEK_BYTES = 4096;
const RPC_MESSAGE_MAX = 200;

const ignore = (): void => undefined;

/**
 * Release a response body nobody will read; a body that is already consumed or locked is left as is.
 * @param body - Response body stream, if any.
 */
async function discardBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (body && !body.locked) await body.cancel().then(ignore, ignore);
}

/**
 * Whether a value is a non-null, non-array object.
 * @param value - Value to test.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a response body, failing once it exceeds `maxBytes`.
 * @param response - Fetch response.
 * @param maxBytes - Byte budget.
 */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().then(ignore, ignore);
      throw new McpClientError('too-large', `MCP response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Parse the `data` payloads of a Server-Sent Events stream (multi-line `data:` fields joined with newlines).
 * @param text - Full event stream text.
 */
export function parseSseData(text: string): string[] {
  const payloads: string[] = [];
  let data: string[] = [];
  const dispatch = () => {
    if (data.length > 0) payloads.push(data.join('\n'));
    data = [];
  };
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line === '') {
      dispatch();
      continue;
    }
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== 'data') continue;
    const value = colon === -1 ? '' : line.slice(colon + 1);
    data.push(value.startsWith(' ') ? value.slice(1) : value);
  }
  dispatch();
  return payloads;
}

/**
 * Pick the JSON-RPC response for `id` out of a parsed body (single message, batch, or SSE payloads).
 * @param messages - Candidate messages.
 * @param id - Request id to match.
 */
function pickResponse(messages: unknown[], id: string): Record<string, unknown> {
  for (const message of messages) {
    if (isRecord(message) && message.id === id && !('method' in message)) {
      if (message.jsonrpc !== '2.0' || (!('result' in message) && !isRecord(message.error))) {
        throw new McpClientError('protocol', 'MCP server sent a malformed JSON-RPC response');
      }
      return message;
    }
  }
  throw new McpClientError('protocol', 'MCP server sent no response for the request');
}

/**
 * Parse a response body into candidate JSON-RPC messages by content type.
 * @param text - Body text.
 * @param contentType - Response `Content-Type`.
 */
function parseMessages(text: string, contentType: string): unknown[] {
  const payloads = contentType.includes('text/event-stream') ? parseSseData(text) : [text];
  const messages: unknown[] = [];
  for (const payload of payloads) {
    if (payload.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw new McpClientError('protocol', 'MCP server sent a body that is not JSON');
    }
    if (Array.isArray(parsed)) messages.push(...parsed);
    else messages.push(parsed);
  }
  return messages;
}

/** Streamable HTTP MCP client with one lazily initialized session. */
export class McpClient {
  private readonly url: string;
  private readonly authToken?: string;
  private readonly clientInfo: { name: string; version: string };
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxListPages: number;
  private readonly fetchImpl: typeof fetch;
  private session: Promise<McpSessionInfo> | null = null;

  /**
   * Create a client; no request is sent until the first call.
   * @param options - Endpoint, credentials and limits.
   */
  constructor(options: McpClientOptions) {
    this.url = options.url;
    this.authToken = options.authToken;
    this.clientInfo = options.clientInfo ?? { name: 'speedwave', version: '1.0.0' };
    this.timeoutMs = options.timeoutMs ?? TIMEOUTS.API_CALL_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.maxListPages = options.maxListPages ?? DEFAULT_MAX_LIST_PAGES;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /**
   * Run the `initialize` handshake now (otherwise it runs on the first call); concurrent callers share one handshake.
   * @param options - Timeout and cancellation.
   */
  initialize(options: McpCallOptions = {}): Promise<McpSessionInfo> {
    if (!this.session) {
      const pending = this.handshake(options);
      this.session = pending;
      pending.catch(() => {
        this.session = null;
      });
    }
    return this.session;
  }

  /**
   * List every tool across pages; definitions are returned unvalidated.
   * @param options - Timeout and cancellation per page.
   */
  async listTools(options: McpCallOptions = {}): Promise<unknown[]> {
    const tools: unknown[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < this.maxListPages; page++) {
      const result = await this.request('tools/list', cursor ? { cursor } : {}, options);
      if (!isRecord(result) || !Array.isArray(result.tools)) {
        throw new McpClientError('protocol', 'tools/list result has no tools array');
      }
      tools.push(...result.tools);
      const next = result.nextCursor;
      if (next === undefined || next === null || next === '') return tools;
      if (typeof next !== 'string' || seen.has(next)) {
        throw new McpClientError('protocol', 'tools/list returned an invalid or repeated cursor');
      }
      seen.add(next);
      cursor = next;
    }
    throw new McpClientError('protocol', `tools/list exceeded ${this.maxListPages} pages`);
  }

  /**
   * Call a tool and return its raw result.
   * @param name - Upstream tool name.
   * @param args - Tool arguments.
   * @param options - Timeout and cancellation.
   */
  callTool(
    name: string,
    args: Record<string, unknown>,
    options: McpCallOptions = {}
  ): Promise<unknown> {
    return this.request('tools/call', { name, arguments: args }, options);
  }

  /**
   * Send `ping`; resolves when the server answers.
   * @param options - Timeout and cancellation.
   */
  async ping(options: McpCallOptions = {}): Promise<void> {
    await this.request('ping', {}, options);
  }

  /**
   * POST one JSON-RPC message.
   * @param body - Message to send.
   * @param session - Session headers to attach, if any.
   * @param options - Timeout and cancellation.
   */
  private async post(
    body: Record<string, unknown>,
    session: McpSessionInfo | null,
    options: McpCallOptions
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': session?.protocolVersion ?? LATEST_PROTOCOL_VERSION,
    };
    if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`;
    if (session?.sessionId) headers['Mcp-Session-Id'] = session.sessionId;
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    try {
      return await this.fetchImpl(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        redirect: 'error',
        signal,
      });
    } catch (error) {
      throw this.transportError(error);
    }
  }

  /**
   * Map a fetch or body-read failure to a {@link McpClientError}.
   * @param error - Thrown value.
   */
  private transportError(error: unknown): McpClientError {
    if (error instanceof McpClientError) return error;
    if (error instanceof Error && error.name === 'TimeoutError') {
      return new McpClientError('timeout', 'MCP request timed out');
    }
    const cause = error instanceof Error ? error.message : String(error);
    return new McpClientError('network', `MCP request failed: ${cause}`);
  }

  /**
   * Read and parse the response matching `id`.
   * @param response - Fetch response.
   * @param id - Request id.
   */
  private async readResponse(response: Response, id: string): Promise<Record<string, unknown>> {
    let text: string;
    try {
      text = await readCapped(response, this.maxResponseBytes);
    } catch (error) {
      throw this.transportError(error);
    }
    return pickResponse(parseMessages(text, response.headers.get('content-type') ?? ''), id);
  }

  /**
   * `initialize` + `notifications/initialized`.
   * @param options - Timeout and cancellation.
   */
  private async handshake(options: McpCallOptions): Promise<McpSessionInfo> {
    const id = randomUUID();
    const response = await this.post(
      {
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: this.clientInfo,
        },
      },
      null,
      options
    );
    if (!response.ok) {
      await discardBody(response.body);
      throw new McpClientError('http', `MCP initialize returned HTTP ${response.status}`, {
        status: response.status,
      });
    }
    const message = await this.readResponse(response, id);
    const result = this.resultOf(message);
    if (!isRecord(result) || typeof result.protocolVersion !== 'string') {
      throw new McpClientError('protocol', 'MCP initialize result has no protocolVersion');
    }
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(result.protocolVersion)) {
      throw new McpClientError('protocol', 'MCP server chose an unsupported protocol version');
    }
    const rawSessionId = response.headers.get('mcp-session-id');
    if (rawSessionId !== null && !SESSION_ID_RE.test(rawSessionId)) {
      throw new McpClientError('protocol', 'MCP server sent an invalid Mcp-Session-Id');
    }
    const session: McpSessionInfo = {
      protocolVersion: result.protocolVersion,
      ...(rawSessionId !== null ? { sessionId: rawSessionId } : {}),
    };
    const notified = await this.post(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      session,
      options
    );
    await discardBody(notified.body);
    if (!notified.ok) {
      throw new McpClientError(
        'http',
        `MCP notifications/initialized returned HTTP ${notified.status}`,
        { status: notified.status }
      );
    }
    return session;
  }

  /**
   * The `result` of a JSON-RPC response, or a thrown `rpc` error.
   * @param message - Matched response.
   */
  private resultOf(message: Record<string, unknown>): unknown {
    if (isRecord(message.error)) {
      const code = typeof message.error.code === 'number' ? message.error.code : undefined;
      const text =
        typeof message.error.message === 'string'
          ? message.error.message.slice(0, RPC_MESSAGE_MAX)
          : 'unknown error';
      throw new McpClientError('rpc', `MCP server error: ${text}`, {
        ...(code !== undefined ? { rpcCode: code } : {}),
      });
    }
    return message.result;
  }

  /**
   * Whether a 400/404 means the server lost or never had our session.
   * @param response - Failed response.
   * @param session - Session the request carried.
   */
  private async isSessionFailure(response: Response, session: McpSessionInfo): Promise<boolean> {
    if (response.status !== 400 && response.status !== 404) return false;
    let body = '';
    try {
      body = (await readCapped(response, ERROR_BODY_PEEK_BYTES)).toLowerCase();
    } catch {
      body = '';
    }
    if (body.includes('not initialized')) return true;
    return (
      response.status === 404 &&
      (session.sessionId !== undefined || body.includes('session') || body.includes('not found'))
    );
  }

  /**
   * Send one request inside the session, re-initializing once when the server lost the session.
   * @param method - JSON-RPC method.
   * @param params - Method params.
   * @param options - Timeout and cancellation.
   */
  private async request(
    method: string,
    params: Record<string, unknown>,
    options: McpCallOptions
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const sessionPromise = this.initialize(options);
      const session = await sessionPromise;
      const id = randomUUID();
      const response = await this.post({ jsonrpc: '2.0', id, method, params }, session, options);
      if (!response.ok) {
        if (attempt === 0 && (await this.isSessionFailure(response, session))) {
          if (this.session === sessionPromise) this.session = null;
          continue;
        }
        await discardBody(response.body);
        throw new McpClientError('http', `MCP ${method} returned HTTP ${response.status}`, {
          status: response.status,
        });
      }
      return this.resultOf(await this.readResponse(response, id));
    }
  }
}
