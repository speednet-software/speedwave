/**
 * MCP Streamable HTTP Transport Utilities: JSON-RPC 2.0 batch support, DELETE session
 * handling, and content negotiation per MCP spec 2025-11-25.
 */

import type { Request, Response } from 'express';
import type { JSONRPCResponse, ProcessRequestResult } from './types.js';
import { JSONRPCErrorCode, SUPPORTED_PROTOCOL_VERSIONS } from './types.js';
import { JSONRPCHandler } from './jsonrpc.js';
import { validateSessionId } from './security.js';
import { sessionManager } from './session.js';
import { createSSEStream, sendJSONResponse } from './sse.js';
import { ts } from './logger.js';

/**
 * Read the session ID from request headers (`Mcp-Session-Id`, falling back to
 * `x-mcp-session-id`); invalid formats are treated as absent.
 * @param req - Express request.
 */
export function readSessionId(req: Request): string | null {
  const raw =
    (req.get('mcp-session-id') as string) || (req.get('x-mcp-session-id') as string) || null;
  if (!raw) return null;
  return validateSessionId(raw) ? raw : null;
}

/**
 * Handle an MCP POST request with support for single and batch JSON-RPC: single requests
 * return JSON/SSE per Accept header, notifications return 202, empty batch = InvalidRequest.
 * @param rpcHandler - The JSON-RPC handler to process individual messages.
 * @param req - Express request.
 * @param res - Express response.
 */
export async function handleMCPPost(
  rpcHandler: JSONRPCHandler,
  req: Request,
  res: Response
): Promise<void> {
  try {
    await handleMCPPostInner(rpcHandler, req, res);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`${ts()} handleMCPPost: unhandled error: ${msg}`);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: JSONRPCErrorCode.InternalError,
          message: 'Internal server error',
        },
      });
    }
  }
}

async function handleMCPPostInner(
  rpcHandler: JSONRPCHandler,
  req: Request,
  res: Response
): Promise<void> {
  const sessionId = readSessionId(req);
  const body = req.body;
  const wantsSSE = req.headers.accept?.includes('text/event-stream') ?? false;

  // Validate MCP-Protocol-Version header
  const protocolVersion = req.get('mcp-protocol-version');
  const isInitialize =
    !Array.isArray(body) &&
    typeof body === 'object' &&
    body !== null &&
    (body as Record<string, unknown>).method === 'initialize';
  if (protocolVersion && !isInitialize && !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
    res.status(400).json({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: JSONRPCErrorCode.InvalidRequest,
        message: `Unsupported MCP-Protocol-Version: ${protocolVersion}`,
      },
    });
    return;
  }

  // Validate Accept header per MCP spec
  const acceptHeader = req.headers.accept;
  if (acceptHeader && !isInitialize) {
    const acceptsAll = acceptHeader.includes('*/*');
    if (
      !acceptsAll &&
      (!acceptHeader.includes('application/json') || !acceptHeader.includes('text/event-stream'))
    ) {
      res.status(406).json({
        error: 'Not Acceptable: Client must accept both application/json and text/event-stream',
      });
      return;
    }
  }

  // Batch request (JSON-RPC 2.0 section 6)
  if (Array.isArray(body)) {
    if (body.length === 0) {
      const errorResponse: JSONRPCResponse = {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: JSONRPCErrorCode.InvalidRequest,
          message: 'Invalid Request: empty batch',
        },
      };
      sendJSONResponse(res, errorResponse);
      return;
    }

    const caller = (res.locals as { caller?: unknown } | undefined)?.caller;
    const ctx = typeof caller === 'string' ? { caller } : undefined;
    const results: ProcessRequestResult[] = await Promise.all(
      body.map((item: unknown) =>
        ctx === undefined
          ? rpcHandler.processRequest(item, sessionId)
          : rpcHandler.processRequest(item, sessionId, ctx)
      )
    );

    // Set session header if any result produced a sessionId (initialize in batch)
    const sessionResult = results.find((r) => r.sessionId);
    if (sessionResult?.sessionId) {
      res.setHeader('Mcp-Session-Id', sessionResult.sessionId);
    }

    // Filter out null responses (notifications)
    const responses = results
      .map((r) => r.response)
      .filter((r): r is JSONRPCResponse => r !== null);

    if (responses.length === 0) {
      res.status(202).end();
      return;
    }

    if (wantsSSE) {
      const stream = createSSEStream(res);
      for (const response of responses) {
        stream.sendMessage(response);
      }
      stream.close();
    } else {
      sendJSONResponse(res, responses);
    }
    return;
  }

  // Single request/notification
  const singleCaller = (res.locals as { caller?: unknown } | undefined)?.caller;
  const singleCtx = typeof singleCaller === 'string' ? { caller: singleCaller } : undefined;
  const result =
    singleCtx === undefined
      ? await rpcHandler.processRequest(body, sessionId)
      : await rpcHandler.processRequest(body, sessionId, singleCtx);

  if (result.sessionId) {
    res.setHeader('Mcp-Session-Id', result.sessionId);
  }

  if (result.response === null) {
    // Notification - no response expected
    res.status(202).end();
    return;
  }

  if (wantsSSE) {
    const stream = createSSEStream(res);
    stream.sendMessage(result.response);
    stream.close();
  } else {
    sendJSONResponse(res, result.response);
  }
}

/**
 * Handle an MCP DELETE request for session termination: reads the session ID (`Mcp-Session-Id`,
 * `x-mcp-session-id` fallback), 400 on missing/invalid format, 204 otherwise (idempotent).
 * @param req - Express request.
 * @param res - Express response.
 */
export function handleMCPDelete(req: Request, res: Response): void {
  const raw =
    (req.get('mcp-session-id') as string) || (req.get('x-mcp-session-id') as string) || null;

  if (!raw) {
    res.status(400).json({ error: 'Missing Mcp-Session-Id header' });
    return;
  }

  if (!validateSessionId(raw)) {
    res.status(400).json({ error: 'Invalid Mcp-Session-Id format' });
    return;
  }

  sessionManager.destroySession(raw);
  res.status(204).end();
}
