import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { ts } from './server/index.js';

export const AUTH_HEADER = 'x-chrome-bridge-auth';

const HANDSHAKE_TIMEOUT_MS = 15_000;
const HANDSHAKE_RETRY_MS = 1_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface RpcResponse {
  id?: string;
  result?: unknown;
  error?: { message?: string };
}

/**
 * Error raised when the extension cannot be reached or answers with an error.
 */
export class BridgeError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_CONFIGURED' | 'NOT_CONNECTED' | 'TIMEOUT' | 'REMOTE'
  ) {
    super(message);
  }
}

/**
 * JSON-RPC client that reaches the Chrome extension through the Speedwave host bridge.
 */
export class BridgeClient {
  private socket: WebSocket | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly url: string | undefined,
    private readonly token: string | undefined,
    private readonly handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS
  ) {}

  /**
   * Sends one command to the extension and waits for its result.
   */
  async call(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = DEFAULT_CALL_TIMEOUT_MS
  ): Promise<unknown> {
    await this.connect();
    return this.send(method, params, timeoutMs);
  }

  private connect(): Promise<void> {
    if (!this.url || !this.token) {
      return Promise.reject(
        new BridgeError(
          'Chrome bridge is not configured: Speedwave Desktop must be running with the chrome plugin enabled.',
          'NOT_CONFIGURED'
        )
      );
    }
    if (!this.ready) {
      this.ready = this.open(this.url, this.token).catch((error: unknown) => {
        this.drop();
        throw error;
      });
    }
    return this.ready;
  }

  private async open(url: string, token: string): Promise<void> {
    const socket = new WebSocket(url, { headers: { [AUTH_HEADER]: token } });
    this.socket = socket;
    socket.on('message', (data) => this.onMessage(data.toString()));
    socket.on('close', () => {
      console.log(`${ts()} bridge socket closed`);
      this.drop();
    });
    socket.on('error', (error) => console.log(`${ts()} bridge socket error: ${error.message}`));

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', () =>
        reject(
          new BridgeError(
            'Speedwave host bridge is not reachable. Is Speedwave Desktop running?',
            'NOT_CONNECTED'
          )
        )
      );
    });

    const deadline = Date.now() + this.handshakeTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const hello = await this.send(
          'hello',
          {},
          Math.max(1, Math.min(HANDSHAKE_RETRY_MS, deadline - Date.now()))
        );
        console.log(`${ts()} paired with extension: ${JSON.stringify(hello)}`);
        return;
      } catch (error) {
        if (!(error instanceof BridgeError) || error.code !== 'TIMEOUT') throw error;
      }
    }
    socket.close();
    throw new BridgeError(
      'The Chrome extension is not connected. Open the Speedwave extension popup in Chrome and check that it shows "connected".',
      'NOT_CONNECTED'
    );
  }

  private send(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number
  ): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new BridgeError('Bridge connection closed.', 'NOT_CONNECTED'));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BridgeError(`Extension did not answer "${method}" within ${timeoutMs} ms.`, 'TIMEOUT')
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  private onMessage(raw: string): void {
    let message: RpcResponse;
    try {
      message = JSON.parse(raw) as RpcResponse;
    } catch {
      return;
    }
    if (!message.id) return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(new BridgeError(message.error.message ?? 'Unknown extension error', 'REMOTE'));
    } else {
      entry.resolve(message.result);
    }
  }

  private drop(): void {
    const socket = this.socket;
    this.socket = null;
    this.ready = null;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new BridgeError('Bridge connection closed.', 'NOT_CONNECTED'));
      this.pending.delete(id);
    }
    if (socket && socket.readyState === WebSocket.OPEN) socket.close();
  }
}
