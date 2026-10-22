/**
 * Newline-delimited JSON-RPC bridge to one MCP server child process: request id rewriting for concurrent callers, refusal of server-initiated requests, and exit tracking.
 * @module custom-launcher/stdio-bridge
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/** A JSON-RPC message as exchanged with the child. */
export type JsonRpcMessage = Record<string, unknown>;

/** Options for {@link StdioBridge}. */
export interface StdioBridgeOptions {
  /** Executable to start (no shell). */
  command: string;
  /** Arguments passed verbatim. */
  args: readonly string[];
  /** Complete environment of the child. */
  env: Record<string, string>;
  /** Upper bound on one stdout line from the child, in bytes. */
  maxLineBytes?: number;
  /** Called once when the child exits or cannot be started. */
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

/** Raised for requests that cannot complete because the child is gone. */
export class BridgeClosedError extends Error {
  /** Create the error. */
  constructor() {
    super('MCP server process is not running');
    this.name = 'BridgeClosedError';
  }
}

/** Raised when the caller abandons a request. */
export class BridgeAbortedError extends Error {
  /** Create the error. */
  constructor() {
    super('request was cancelled by the client');
    this.name = 'BridgeAbortedError';
  }
}

/** Default upper bound on one stdout line from the child. */
export const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;

const SERVER_PING = 'ping';

interface Pending {
  originalId: string | number;
  resolve: (message: JsonRpcMessage) => void;
  reject: (error: Error) => void;
}

/**
 * Whether a value is a non-null, non-array object.
 * @param value - Value to test.
 */
function isRecord(value: unknown): value is JsonRpcMessage {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Bridge to a stdio MCP server that speaks newline-delimited JSON-RPC. */
export class StdioBridge {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly maxLineBytes: number;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffered: Buffer[] = [];
  private bufferedBytes = 0;
  private alive = true;
  private warnedNonJson = false;

  /**
   * Start the child process.
   * @param options - Command, environment and exit callback.
   */
  constructor(private readonly options: StdioBridgeOptions) {
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.child = spawn(options.command, [...options.args], {
      env: options.env,
      stdio: ['pipe', 'pipe', 'inherit'],
      shell: false,
    }) as unknown as ChildProcessWithoutNullStreams;
    this.child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    this.child.stdin.on('error', () => undefined);
    this.child.on('error', (error) => {
      console.error(`MCP server process could not be started: ${error.message}`);
      this.closed(null, null);
    });
    this.child.on('exit', (code, signal) => this.closed(code, signal));
  }

  /** Whether the child is still running. */
  get running(): boolean {
    return this.alive;
  }

  /**
   * Send a request and resolve with the child's response under the caller's original id.
   * @param message - JSON-RPC request with a string or number id.
   * @param signal - Aborts the request and sends `notifications/cancelled` to the child.
   */
  request(message: JsonRpcMessage, signal?: AbortSignal): Promise<JsonRpcMessage> {
    if (!this.alive) return Promise.reject(new BridgeClosedError());
    const originalId = message.id as string | number;
    const id = this.nextId++;
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        this.write({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: id, reason: 'client disconnected' },
        });
        reject(new BridgeAbortedError());
      };
      this.pending.set(id, {
        originalId,
        resolve: (response) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(response);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.write({ ...message, id });
    });
  }

  /**
   * Forward a notification; dropped when the child is gone.
   * @param message - JSON-RPC notification.
   */
  notify(message: JsonRpcMessage): void {
    if (this.alive) this.write(message);
  }

  /**
   * Terminate the child.
   * @param signal - Signal to send.
   */
  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.alive) this.child.kill(signal);
  }

  /**
   * Write one message as a line to the child's stdin.
   * @param message - Message to send.
   */
  private write(message: JsonRpcMessage): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /**
   * Split stdout into lines, enforcing the line size cap.
   * @param chunk - Raw stdout chunk.
   */
  private onData(chunk: Buffer): void {
    let start = 0;
    let newline = chunk.indexOf(0x0a, start);
    while (newline !== -1) {
      this.buffered.push(chunk.subarray(start, newline));
      const line = Buffer.concat(this.buffered).toString('utf8');
      this.buffered = [];
      this.bufferedBytes = 0;
      this.onLine(line);
      start = newline + 1;
      newline = chunk.indexOf(0x0a, start);
    }
    const rest = chunk.subarray(start);
    this.bufferedBytes += rest.length;
    if (this.bufferedBytes > this.maxLineBytes) {
      console.error(`MCP server wrote a line longer than ${this.maxLineBytes} bytes; stopping it`);
      this.buffered = [];
      this.bufferedBytes = 0;
      this.child.kill('SIGKILL');
      return;
    }
    if (rest.length > 0) this.buffered.push(rest);
  }

  /**
   * Handle one line from the child.
   * @param raw - Line text without the newline.
   */
  private onLine(raw: string): void {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '') return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      if (!this.warnedNonJson) {
        this.warnedNonJson = true;
        console.error('MCP server wrote a non-JSON line to stdout; ignoring such lines');
      }
      return;
    }
    if (!isRecord(message)) return;
    const hasId = typeof message.id === 'string' || typeof message.id === 'number';
    if (typeof message.method === 'string') {
      if (hasId) this.refuseServerRequest(message.id as string | number, message.method);
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    pending.resolve({ ...message, id: pending.originalId });
  }

  /**
   * Answer a request the child sent to its client: `ping` succeeds, everything else (sampling, elicitation, roots) is refused.
   * @param id - The child's request id.
   * @param method - Requested method.
   */
  private refuseServerRequest(id: string | number, method: string): void {
    if (method === SERVER_PING) {
      this.write({ jsonrpc: '2.0', id, result: {} });
      return;
    }
    this.write({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32601,
        message: 'Speedwave does not support requests from the server to the client',
      },
    });
  }

  /**
   * Mark the child gone, fail every pending request and report the exit once.
   * @param code - Exit code.
   * @param signal - Terminating signal.
   */
  private closed(code: number | null, signal: NodeJS.Signals | null): void {
    if (!this.alive) return;
    this.alive = false;
    for (const pending of this.pending.values()) pending.reject(new BridgeClosedError());
    this.pending.clear();
    this.options.onExit(code, signal);
  }
}
