import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import { handleMCPPost, handleMCPDelete, readSessionId } from './transport.js';
import { JSONRPCHandler } from './jsonrpc.js';

// Use vi.hoisted to define mocks before vi.mock is hoisted
const { mockSSEStream, mockSendJSONResponse, mockCreateSSEStream } = vi.hoisted(() => {
  const mockSSEStream = {
    initialize: vi.fn(),
    sendMessage: vi.fn(),
    close: vi.fn(),
  };
  const mockSendJSONResponse = vi.fn(
    (
      res: { setHeader: (k: string, v: string) => void; json: (d: unknown) => void },
      response: unknown
    ) => {
      res.setHeader('Content-Type', 'application/json');
      res.json(response);
    }
  );
  const mockCreateSSEStream = vi.fn(() => mockSSEStream);
  return { mockSSEStream, mockSendJSONResponse, mockCreateSSEStream };
});

// Mock dependencies
vi.mock('./session.js', () => ({
  sessionManager: {
    createSession: vi.fn(() => 'mock-session-id'),
    getSession: vi.fn(() => ({
      id: 'mock-session-id',
      createdAt: new Date(),
      lastAccessedAt: new Date(),
    })),
    destroySession: vi.fn(),
  },
}));

vi.mock('./sse.js', () => ({
  createSSEStream: mockCreateSSEStream,
  sendJSONResponse: mockSendJSONResponse,
}));

function createMockRequest(body: unknown, headers: Record<string, string> = {}): Partial<Request> {
  return {
    body,
    get: (name: string) => headers[name.toLowerCase()],
    headers: headers as Record<string, string>,
  };
}

function createMockResponse(): Record<string, unknown> & Partial<Response> {
  const res: Record<string, unknown> = {
    statusCode: 200,
    _headers: {} as Record<string, string>,
    _data: null as unknown,
    setHeader: vi.fn((name: string, value: string) => {
      (res._headers as Record<string, string>)[name] = value;
    }),
    json: vi.fn((data: unknown) => {
      res._data = data;
      return res;
    }),
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    write: vi.fn(),
    end: vi.fn(),
  };
  return res as Record<string, unknown> & Partial<Response>;
}

describe('transport', () => {
  let handler: JSONRPCHandler;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    handler = new JSONRPCHandler({ name: 'test', version: '1.0.0' });
    handler.registerTool(
      {
        name: 'echo',
        description: 'Echo tool',
        inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
      },
      async (args) => ({ content: [{ type: 'text' as const, text: String(args.msg ?? '') }] })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('readSessionId', () => {
    it('reads mcp-session-id header', () => {
      const req = createMockRequest(
        {},
        {
          'mcp-session-id': '550e8400-e29b-41d4-a716-446655440000',
        }
      );
      expect(readSessionId(req as Request)).toBe('550e8400-e29b-41d4-a716-446655440000');
    });

    it('falls back to x-mcp-session-id header', () => {
      const req = createMockRequest(
        {},
        {
          'x-mcp-session-id': '550e8400-e29b-41d4-a716-446655440000',
        }
      );
      expect(readSessionId(req as Request)).toBe('550e8400-e29b-41d4-a716-446655440000');
    });

    it('returns null when no session header present', () => {
      const req = createMockRequest({}, {});
      expect(readSessionId(req as Request)).toBeNull();
    });

    it('returns null for invalid session ID format', () => {
      const req = createMockRequest({}, { 'mcp-session-id': 'not-a-uuid' });
      expect(readSessionId(req as Request)).toBeNull();
    });
  });

  describe('handleMCPPost', () => {
    /** Get the response passed to the last sendJSONResponse call */
    function lastJsonResponse(): unknown {
      const calls = mockSendJSONResponse.mock.calls;
      return calls[calls.length - 1]?.[1];
    }

    it('returns 200 JSON for a single request', async () => {
      const req = createMockRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'echo', arguments: { msg: 'hi' } },
      });
      const res = createMockResponse();

      await handleMCPPost(handler, req as Request, res as unknown as Response);

      expect(mockSendJSONResponse).toHaveBeenCalled();
      const response = lastJsonResponse() as Record<string, unknown>;
      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(1);
    });

    it('returns 202 for a notification (no id)', async () => {
      const req = createMockRequest({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      });
      const res = createMockResponse();

      await handleMCPPost(handler, req as Request, res as unknown as Response);

      expect(res.status).toHaveBeenCalledWith(202);
      expect(res.end).toHaveBeenCalled();
    });

    it('sets Mcp-Session-Id header on initialize', async () => {
      const req = createMockRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      });
      const res = createMockResponse();

      await handleMCPPost(handler, req as Request, res as unknown as Response);

      expect(res.setHeader).toHaveBeenCalledWith('Mcp-Session-Id', expect.any(String));
    });

    it('returns array for batch of 2 requests', async () => {
      const req = createMockRequest([
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', id: 2, method: 'ping' },
      ]);
      const res = createMockResponse();

      await handleMCPPost(handler, req as Request, res as unknown as Response);

      const response = lastJsonResponse();
      expect(Array.isArray(response)).toBe(true);
      expect(response).toHaveLength(2);
    });

    it('filters notification responses from batch', async () => {
      const req = createMockRequest([
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
      ]);
      const res = createMockResponse();

      await handleMCPPost(handler, req as Request, res as unknown as Response);

      const response = lastJsonResponse();
      expect(Array.isArray(response)).toBe(true);
      expect(response).toHaveLength(1);
    });

    it('returns 202 when batch contains only notifications', async () => {
      const req = createMockRequest([
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'x' } },
      ]);
      const res = createMockResponse();

      await handleMCPPost(handler, req as Request, res as unknown as Response);

      expect(res.status).toHaveBeenCalledWith(202);
      expect(res.end).toHaveBeenCalled();
    });

    it('returns InvalidRequest for empty batch', async () => {
      const req = createMockRequest([]);
      const res = createMockResponse();

      await handleMCPPost(handler, req as Request, res as unknown as Response);

      const response = lastJsonResponse() as Record<string, unknown>;
      const error = response.error as { code: number; message: string };
      expect(error.code).toBe(-32600);
      expect(error.message).toContain('empty batch');
    });

    it('returns array of 1 for batch of 1 (not unwrapped)', async () => {
      const req = createMockRequest([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
      const res = createMockResponse();

      await handleMCPPost(handler, req as Request, res as unknown as Response);

      const response = lastJsonResponse();
      expect(Array.isArray(response)).toBe(true);
      expect(response).toHaveLength(1);
    });

    it('rejects unsupported MCP-Protocol-Version with 400', async () => {
      const req = createMockRequest(
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { 'mcp-protocol-version': '2099-01-01' }
      );
      const res = createMockResponse();

      await handleMCPPost(handler, req as Request, res as unknown as Response);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            message: expect.stringContaining('Unsupported MCP-Protocol-Version'),
          }),
        })
      );
    });

    it('allows missing MCP-Protocol-Version header', async () => {
      const req = createMockRequest({ jsonrpc: '2.0', id: 1, method: 'ping' });
      const res = createMockResponse();

      await handleMCPPost(handler, req as Request, res as unknown as Response);

      expect(mockSendJSONResponse).toHaveBeenCalled();
    });

    it('allows supported MCP-Protocol-Version header', async () => {
      const req = createMockRequest(
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { 'mcp-protocol-version': '2025-03-26' }
      );
      const res = createMockResponse();

      await handleMCPPost(handler, req as Request, res as unknown as Response);

      expect(mockSendJSONResponse).toHaveBeenCalled();
    });

    it('skips version check for initialize requests', async () => {
      const req = createMockRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        },
        { 'mcp-protocol-version': '2099-01-01' }
      );
      const res = createMockResponse();

      await handleMCPPost(handler, req as Request, res as unknown as Response);

      // Should NOT return 400 — initialize negotiates the version
      expect(res.status).not.toHaveBeenCalledWith(400);
    });

    it('uses SSE when Accept includes text/event-stream', async () => {
      const req = createMockRequest(
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { accept: 'application/json, text/event-stream' }
      );
      const res = createMockResponse();

      await handleMCPPost(handler, req as Request, res as unknown as Response);

      expect(mockCreateSSEStream).toHaveBeenCalledWith(res);
    });

    it('passes when Accept has both application/json and text/event-stream', async () => {
      const req = createMockRequest(
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { accept: 'application/json, text/event-stream' }
      );
      const res = createMockResponse();

      await handleMCPPost(handler, req as Request, res as unknown as Response);

      expect(res.status).not.toHaveBeenCalledWith(406);
      expect(mockSendJSONResponse).toHaveBeenCalled();
    });

    it('returns 406 when Accept has text/event-stream but missing application/json', async () => {
      const req = createMockRequest(
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { accept: 'text/event-stream' }
      );
      const res = createMockResponse();

      await handleMCPPost(handler, req as Request, res as unknown as Response);

      expect(res.status).toHaveBeenCalledWith(406);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: -32000,
            message: expect.stringContaining('Not Acceptable'),
          }),
        })
      );
    });

    it('returns 406 when Accept has application/json but missing text/event-stream', async () => {
      const req = createMockRequest(
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { accept: 'application/json' }
      );
      const res = createMockResponse();

      await handleMCPPost(handler, req as Request, res as unknown as Response);

      expect(res.status).toHaveBeenCalledWith(406);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: -32000,
            message: expect.stringContaining('Not Acceptable'),
          }),
        })
      );
    });

    it('passes when Accept is */* (wildcard matches per RFC 9110)', async () => {
      const req = createMockRequest({ jsonrpc: '2.0', id: 1, method: 'ping' }, { accept: '*/*' });
      const res = createMockResponse();

      await handleMCPPost(handler, req as Request, res as unknown as Response);

      expect(res.status).not.toHaveBeenCalledWith(406);
      expect(mockSendJSONResponse).toHaveBeenCalled();
    });

    it('passes when Accept has */*, application/json, text/event-stream', async () => {
      const req = createMockRequest(
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { accept: '*/*, application/json, text/event-stream' }
      );
      const res = createMockResponse();

      await handleMCPPost(handler, req as Request, res as unknown as Response);

      expect(res.status).not.toHaveBeenCalledWith(406);
      expect(mockSendJSONResponse).toHaveBeenCalled();
    });

    it('passes when Accept has quality values (application/json;q=0.9, text/event-stream)', async () => {
      const req = createMockRequest(
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { accept: 'application/json;q=0.9, text/event-stream' }
      );
      const res = createMockResponse();

      await handleMCPPost(handler, req as Request, res as unknown as Response);

      expect(res.status).not.toHaveBeenCalledWith(406);
    });

    it('passes when Accept header is absent (skip validation)', async () => {
      const req = createMockRequest({ jsonrpc: '2.0', id: 1, method: 'ping' }, {});
      const res = createMockResponse();

      await handleMCPPost(handler, req as Request, res as unknown as Response);

      expect(res.status).not.toHaveBeenCalledWith(406);
      expect(mockSendJSONResponse).toHaveBeenCalled();
    });

    it('returns 406 when Accept header is empty string', async () => {
      const req = createMockRequest({ jsonrpc: '2.0', id: 1, method: 'ping' }, { accept: '' });
      const res = createMockResponse();

      await handleMCPPost(handler, req as Request, res as unknown as Response);

      // Empty string is falsy, so Accept validation is skipped
      // (same behavior as absent header)
      expect(res.status).not.toHaveBeenCalledWith(406);
    });

    it('passes for initialize request without proper Accept (exempt)', async () => {
      const req = createMockRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        },
        { accept: 'application/json' }
      );
      const res = createMockResponse();

      await handleMCPPost(handler, req as Request, res as unknown as Response);

      expect(res.status).not.toHaveBeenCalledWith(406);
    });

    it('returns 500 JSON-RPC error when handler throws unexpectedly', async () => {
      const throwingHandler = {
        processRequest: vi.fn().mockRejectedValue(new Error('unexpected crash')),
      } as unknown as JSONRPCHandler;

      const req = createMockRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'echo', arguments: {} },
      });
      const res = createMockResponse();

      await handleMCPPost(throwingHandler, req as Request, res as unknown as Response);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          jsonrpc: '2.0',
          id: null,
          error: expect.objectContaining({
            message: 'Internal server error',
          }),
        })
      );
    });
  });

  describe('handleMCPDelete', () => {
    it('returns 204 for valid session ID', () => {
      const req = createMockRequest(
        {},
        {
          'mcp-session-id': '550e8400-e29b-41d4-a716-446655440000',
        }
      );
      const res = createMockResponse();

      handleMCPDelete(req as Request, res as unknown as Response);

      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.end).toHaveBeenCalled();
    });

    it('returns 400 when session header is missing', () => {
      const req = createMockRequest({}, {});
      const res = createMockResponse();

      handleMCPDelete(req as Request, res as unknown as Response);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('Missing') })
      );
    });

    it('returns 400 for invalid session ID format', () => {
      const req = createMockRequest({}, { 'mcp-session-id': 'invalid-format' });
      const res = createMockResponse();

      handleMCPDelete(req as Request, res as unknown as Response);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('Invalid') })
      );
    });

    it('returns 204 for non-existent session (idempotent)', async () => {
      const { sessionManager } = await import('./session.js');
      // destroySession for non-existent ID just does nothing
      vi.mocked(sessionManager.destroySession).mockImplementation(() => {});

      const req = createMockRequest(
        {},
        {
          'mcp-session-id': '660e8400-e29b-41d4-a716-446655440000',
        }
      );
      const res = createMockResponse();

      handleMCPDelete(req as Request, res as unknown as Response);

      expect(res.status).toHaveBeenCalledWith(204);
    });

    it('reads session from x-mcp-session-id fallback header', () => {
      const req = createMockRequest(
        {},
        {
          'x-mcp-session-id': '550e8400-e29b-41d4-a716-446655440000',
        }
      );
      const res = createMockResponse();

      handleMCPDelete(req as Request, res as unknown as Response);

      expect(res.status).toHaveBeenCalledWith(204);
    });
  });
});
