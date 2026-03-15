/**
 * SSE (Server-Sent Events) Streaming Module for MCP
 * Implements Streamable HTTP transport (MCP spec 2025-03-26)
 */

import { Response } from 'express';
import type { SSEEvent, JSONRPCResponse, JSONRPCError } from './types.js';

/**
 * SSE Stream class for sending Server-Sent Events
 */
export class SSEStream {
  private res: Response;
  private eventId = 0;

  /**
   * Creates a new SSE stream for the given response
   * @param res - Express response object to stream to
   */
  constructor(res: Response) {
    this.res = res;
  }

  /**
   * Initialize SSE headers
   */
  public initialize(): void {
    this.res.setHeader('Content-Type', 'text/event-stream');
    this.res.setHeader('Cache-Control', 'no-cache');
    this.res.setHeader('Connection', 'keep-alive');
    this.res.setHeader('X-Accel-Buffering', 'no');
    this.res.write(': MCP SSE stream initialized\n\n');
  }

  /**
   * Send a JSON-RPC response as SSE message
   * @param response - JSON-RPC response to send
   */
  public sendMessage(response: JSONRPCResponse): void {
    const event: SSEEvent = {
      id: (this.eventId++).toString(),
      event: 'message',
      data: JSON.stringify(response),
    };
    this.sendEvent(event);
  }

  /**
   * Send multiple responses as batch
   * @param responses - Array of JSON-RPC responses to send
   */
  public sendBatch(responses: JSONRPCResponse[]): void {
    for (const response of responses) {
      this.sendMessage(response);
    }
  }

  /**
   * Send a raw SSE event.
   * Safety: event.data is always produced by JSON.stringify() in sendMessage(),
   * so it cannot contain raw user input. The SSE spec fields (id, event, retry)
   * are set internally — never from external input.
   * @param event - SSE event structure to send
   */
  private sendEvent(event: SSEEvent): void {
    let message = '';

    if (event.id !== undefined) {
      message += `id: ${String(event.id)}\n`;
    }

    if (event.event) {
      message += `event: ${String(event.event)}\n`;
    }

    if (event.retry !== undefined) {
      message += `retry: ${String(event.retry)}\n`;
    }

    if (event.data) {
      for (const line of String(event.data).split('\n')) {
        message += `data: ${line}\n`;
      }
    }

    message += '\n';
    this.res.write(message);
  }

  /**
   * Send an error response
   * @param error - JSON-RPC error object to send
   * @param requestId - Request ID to correlate the error with
   */
  public sendError(error: JSONRPCError, requestId: string | number): void {
    const response: JSONRPCResponse = {
      jsonrpc: '2.0',
      id: requestId,
      error,
    };
    this.sendMessage(response);
  }

  /**
   * Close the SSE stream
   */
  public close(): void {
    this.res.write(': stream closing\n\n');
    this.res.end();
  }

  /**
   * Send a heartbeat comment
   */
  public sendHeartbeat(): void {
    this.res.write(': heartbeat\n\n');
  }
}

/**
 * Create and initialize an SSE stream
 * @param res Express response object
 * @returns Initialized SSE stream
 */
export function createSSEStream(res: Response): SSEStream {
  const stream = new SSEStream(res);
  stream.initialize();
  return stream;
}

/**
 * Send a standard JSON response (non-SSE)
 * @param res Express response object
 * @param response JSON-RPC response
 */
export function sendJSONResponse(res: Response, response: JSONRPCResponse): void {
  res.setHeader('Content-Type', 'application/json');
  res.json(response);
}
