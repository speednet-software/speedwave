import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SSEStream, createSSEStream, sendJSONResponse } from './sse.js';
import type { JSONRPCResponse, JSONRPCError } from './types.js';
import { JSONRPCErrorCode } from './types.js';
import type { Response } from 'express';

/**
 * Mock Express Response object
 */
const mockResponse = () => {
  const res: any = {
    writeHead: vi.fn(),
    setHeader: vi.fn(),
    write: vi.fn().mockReturnValue(true),
    end: vi.fn(),
    on: vi.fn(),
    json: vi.fn(),
  };
  return res as Response;
};

describe('sse', () => {
  describe('SSEStream', () => {
    let mockRes: Response;
    let stream: SSEStream;

    beforeEach(() => {
      mockRes = mockResponse();
      stream = new SSEStream(mockRes);
    });

    describe('constructor', () => {
      it('creates an SSEStream instance', () => {
        expect(stream).toBeInstanceOf(SSEStream);
      });

      it('does not set headers on construction', () => {
        expect(mockRes.setHeader).not.toHaveBeenCalled();
      });
    });

    describe('initialize', () => {
      it('sets correct SSE headers', () => {
        stream.initialize();

        expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
        expect(mockRes.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
        expect(mockRes.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
        expect(mockRes.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no');
        expect(mockRes.setHeader).toHaveBeenCalledTimes(4);
      });

      it('writes initialization comment', () => {
        stream.initialize();

        expect(mockRes.write).toHaveBeenCalledWith(': MCP SSE stream initialized\n\n');
      });

      it('can be called multiple times', () => {
        stream.initialize();
        stream.initialize();

        expect(mockRes.setHeader).toHaveBeenCalledTimes(8);
        expect(mockRes.write).toHaveBeenCalledTimes(2);
      });
    });

    describe('sendMessage', () => {
      it('sends a JSON-RPC response as SSE message', () => {
        const response: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: 1,
          result: { success: true },
        };

        stream.sendMessage(response);

        expect(mockRes.write).toHaveBeenCalledTimes(1);
        const written = mockRes.write.mock.calls[0][0];
        expect(written).toContain('id: 0\n');
        expect(written).toContain('event: message\n');
        expect(written).toContain('data: ');
        expect(written).toContain(JSON.stringify(response));
        expect(written.endsWith('\n\n')).toBe(true);
      });

      it('increments event ID for multiple messages', () => {
        const response: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: 1,
          result: { data: 'test' },
        };

        stream.sendMessage(response);
        stream.sendMessage(response);
        stream.sendMessage(response);

        expect(mockRes.write).toHaveBeenCalledTimes(3);
        expect(mockRes.write.mock.calls[0][0]).toContain('id: 0\n');
        expect(mockRes.write.mock.calls[1][0]).toContain('id: 1\n');
        expect(mockRes.write.mock.calls[2][0]).toContain('id: 2\n');
      });

      it('handles response with null id', () => {
        const response: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: null,
          result: { data: 'test' },
        };

        stream.sendMessage(response);

        const written = mockRes.write.mock.calls[0][0];
        expect(written).toContain(JSON.stringify(response));
      });

      it('handles response with string id', () => {
        const response: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: 'request-123',
          result: { data: 'test' },
        };

        stream.sendMessage(response);

        const written = mockRes.write.mock.calls[0][0];
        expect(written).toContain(JSON.stringify(response));
      });

      it('handles response with error field', () => {
        const response: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: 1,
          error: {
            code: -32600,
            message: 'Invalid Request',
          },
        };

        stream.sendMessage(response);

        const written = mockRes.write.mock.calls[0][0];
        expect(written).toContain(JSON.stringify(response));
      });

      it('handles response with complex nested data', () => {
        const response: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: 1,
          result: {
            nested: {
              deeply: {
                data: [1, 2, 3],
                object: { key: 'value' },
              },
            },
          },
        };

        stream.sendMessage(response);

        const written = mockRes.write.mock.calls[0][0];
        expect(written).toContain(JSON.stringify(response));
      });

      it('handles response with special characters in data', () => {
        const response: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: 1,
          result: {
            message: 'Test with "quotes" and \'apostrophes\' and \n newlines',
          },
        };

        stream.sendMessage(response);

        const written = mockRes.write.mock.calls[0][0];
        expect(written).toContain(JSON.stringify(response));
        expect(written).toContain('event: message\n');
      });
    });

    describe('sendBatch', () => {
      it('sends multiple responses in sequence', () => {
        const responses: JSONRPCResponse[] = [
          { jsonrpc: '2.0', id: 1, result: { data: 'first' } },
          { jsonrpc: '2.0', id: 2, result: { data: 'second' } },
          { jsonrpc: '2.0', id: 3, result: { data: 'third' } },
        ];

        stream.sendBatch(responses);

        expect(mockRes.write).toHaveBeenCalledTimes(3);
        expect(mockRes.write.mock.calls[0][0]).toContain('id: 0\n');
        expect(mockRes.write.mock.calls[1][0]).toContain('id: 1\n');
        expect(mockRes.write.mock.calls[2][0]).toContain('id: 2\n');
      });

      it('handles empty batch', () => {
        stream.sendBatch([]);

        expect(mockRes.write).not.toHaveBeenCalled();
      });

      it('handles single response in batch', () => {
        const responses: JSONRPCResponse[] = [{ jsonrpc: '2.0', id: 1, result: { data: 'only' } }];

        stream.sendBatch(responses);

        expect(mockRes.write).toHaveBeenCalledTimes(1);
        expect(mockRes.write.mock.calls[0][0]).toContain(JSON.stringify(responses[0]));
      });

      it('maintains event ID sequence across batch', () => {
        stream.sendMessage({ jsonrpc: '2.0', id: 0, result: {} });

        stream.sendBatch([
          { jsonrpc: '2.0', id: 1, result: {} },
          { jsonrpc: '2.0', id: 2, result: {} },
        ]);

        expect(mockRes.write.mock.calls[0][0]).toContain('id: 0\n');
        expect(mockRes.write.mock.calls[1][0]).toContain('id: 1\n');
        expect(mockRes.write.mock.calls[2][0]).toContain('id: 2\n');
      });
    });

    describe('sendError', () => {
      it('sends an error response with correct format', () => {
        const error: JSONRPCError = {
          code: JSONRPCErrorCode.InvalidRequest,
          message: 'Invalid Request',
        };

        stream.sendError(error, 1);

        expect(mockRes.write).toHaveBeenCalledTimes(1);
        const written = mockRes.write.mock.calls[0][0];
        expect(written).toContain('event: message\n');
        expect(written).toContain('"jsonrpc":"2.0"');
        expect(written).toContain('"id":1');
        expect(written).toContain('"error"');
        expect(written).toContain('"code":-32600');
        expect(written).toContain('"message":"Invalid Request"');
      });

      it('handles error with string request id', () => {
        const error: JSONRPCError = {
          code: JSONRPCErrorCode.MethodNotFound,
          message: 'Method not found',
        };

        stream.sendError(error, 'request-abc');

        const written = mockRes.write.mock.calls[0][0];
        expect(written).toContain('"id":"request-abc"');
        expect(written).toContain('"error"');
      });

      it('handles error with additional data', () => {
        const error: JSONRPCError = {
          code: JSONRPCErrorCode.InvalidParams,
          message: 'Invalid parameters',
          data: { details: 'Missing required field: name' },
        };

        stream.sendError(error, 1);

        const written = mockRes.write.mock.calls[0][0];
        expect(written).toContain('"data"');
        expect(written).toContain('Missing required field: name');
      });

      it('handles various error codes', () => {
        const errors = [
          { code: JSONRPCErrorCode.ParseError, message: 'Parse error' },
          { code: JSONRPCErrorCode.InvalidRequest, message: 'Invalid Request' },
          { code: JSONRPCErrorCode.MethodNotFound, message: 'Method not found' },
          { code: JSONRPCErrorCode.InvalidParams, message: 'Invalid params' },
          { code: JSONRPCErrorCode.InternalError, message: 'Internal error' },
        ];

        errors.forEach((error, index) => {
          stream.sendError(error, index);
        });

        expect(mockRes.write).toHaveBeenCalledTimes(5);
        expect(mockRes.write.mock.calls[0][0]).toContain('-32700');
        expect(mockRes.write.mock.calls[1][0]).toContain('-32600');
        expect(mockRes.write.mock.calls[2][0]).toContain('-32601');
        expect(mockRes.write.mock.calls[3][0]).toContain('-32602');
        expect(mockRes.write.mock.calls[4][0]).toContain('-32603');
      });
    });

    describe('sendHeartbeat', () => {
      it('sends heartbeat comment', () => {
        stream.sendHeartbeat();

        expect(mockRes.write).toHaveBeenCalledWith(': heartbeat\n\n');
      });

      it('can send multiple heartbeats', () => {
        stream.sendHeartbeat();
        stream.sendHeartbeat();
        stream.sendHeartbeat();

        expect(mockRes.write).toHaveBeenCalledTimes(3);
        expect(mockRes.write).toHaveBeenCalledWith(': heartbeat\n\n');
      });

      it('heartbeat does not affect event ID counter', () => {
        stream.sendMessage({ jsonrpc: '2.0', id: 1, result: {} });
        stream.sendHeartbeat();
        stream.sendMessage({ jsonrpc: '2.0', id: 2, result: {} });

        expect(mockRes.write.mock.calls[0][0]).toContain('id: 0\n');
        expect(mockRes.write.mock.calls[1][0]).toBe(': heartbeat\n\n');
        expect(mockRes.write.mock.calls[2][0]).toContain('id: 1\n');
      });
    });

    describe('close', () => {
      it('writes closing comment and ends stream', () => {
        stream.close();

        expect(mockRes.write).toHaveBeenCalledWith(': stream closing\n\n');
        expect(mockRes.end).toHaveBeenCalledTimes(1);
      });

      it('can be called multiple times safely', () => {
        stream.close();
        stream.close();

        expect(mockRes.write).toHaveBeenCalledTimes(2);
        expect(mockRes.end).toHaveBeenCalledTimes(2);
      });

      it('closes after sending messages', () => {
        stream.sendMessage({ jsonrpc: '2.0', id: 1, result: {} });
        stream.sendHeartbeat();
        stream.close();

        expect(mockRes.write).toHaveBeenCalledTimes(3);
        expect(mockRes.end).toHaveBeenCalledTimes(1);
      });
    });

    describe('SSE format compliance', () => {
      it('formats SSE messages with proper line endings', () => {
        stream.sendMessage({ jsonrpc: '2.0', id: 1, result: {} });

        const written = mockRes.write.mock.calls[0][0];
        expect(written).toMatch(/id: \d+\n/);
        expect(written).toMatch(/event: message\n/);
        expect(written).toMatch(/data: .*\n/);
        expect(written.endsWith('\n\n')).toBe(true);
      });

      it('handles multiline data correctly', () => {
        const response: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: 1,
          result: {
            message: 'line1\nline2\nline3',
          },
        };

        stream.sendMessage(response);

        const written = mockRes.write.mock.calls[0][0];
        // JSON.stringify will escape newlines, so they appear as \n in the JSON string
        expect(written).toContain('data: ');
        expect(written).toContain('\\n');
      });

      it('formats events with all required fields', () => {
        stream.sendMessage({ jsonrpc: '2.0', id: 1, result: { test: true } });

        const written = mockRes.write.mock.calls[0][0];
        const lines = written.split('\n');

        expect(lines[0]).toMatch(/^id: \d+$/);
        expect(lines[1]).toBe('event: message');
        expect(lines[2]).toMatch(/^data: \{.*\}$/);
        expect(lines[3]).toBe('');
        expect(lines[4]).toBe('');
      });
    });

    describe('edge cases', () => {
      it('handles empty result object', () => {
        const response: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: 1,
          result: {},
        };

        stream.sendMessage(response);

        const written = mockRes.write.mock.calls[0][0];
        expect(written).toContain('data: ');
        expect(written).toContain(JSON.stringify(response));
      });

      it('handles undefined result', () => {
        const response: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: 1,
        };

        stream.sendMessage(response);

        const written = mockRes.write.mock.calls[0][0];
        expect(written).toContain('data: ');
      });

      it('handles numeric zero as id', () => {
        const response: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: 0,
          result: { data: 'test' },
        };

        stream.sendMessage(response);

        const written = mockRes.write.mock.calls[0][0];
        expect(written).toContain('"id":0');
      });

      it('handles large payloads', () => {
        const largeData = {
          items: Array.from({ length: 1000 }, (_, i) => ({
            id: i,
            name: `Item ${i}`,
            description: 'A'.repeat(100),
          })),
        };

        const response: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: 1,
          result: largeData,
        };

        stream.sendMessage(response);

        const written = mockRes.write.mock.calls[0][0];
        expect(written).toContain('data: ');
        expect(written.length).toBeGreaterThan(100000);
      });

      it('handles unicode characters', () => {
        const response: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: 1,
          result: {
            message: '你好世界 🌍 Привет мир',
          },
        };

        stream.sendMessage(response);

        const written = mockRes.write.mock.calls[0][0];
        expect(written).toContain('data: ');
        expect(written).toContain(JSON.stringify(response));
      });

      it('handles response with all error codes', () => {
        const customError: JSONRPCError = {
          code: JSONRPCErrorCode.SessionError,
          message: 'Session error',
        };

        stream.sendError(customError, 1);

        const written = mockRes.write.mock.calls[0][0];
        expect(written).toContain('-32001');
      });
    });
  });

  describe('createSSEStream', () => {
    it('creates and initializes an SSEStream', () => {
      const mockRes = mockResponse();

      const stream = createSSEStream(mockRes);

      expect(stream).toBeInstanceOf(SSEStream);
      expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
      expect(mockRes.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
      expect(mockRes.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
      expect(mockRes.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no');
      expect(mockRes.write).toHaveBeenCalledWith(': MCP SSE stream initialized\n\n');
    });

    it('returns a working SSEStream instance', () => {
      const mockRes = mockResponse();

      const stream = createSSEStream(mockRes);
      stream.sendMessage({ jsonrpc: '2.0', id: 1, result: { test: true } });

      expect(mockRes.write).toHaveBeenCalledTimes(2); // 1 for init, 1 for message
    });

    it('can be used immediately after creation', () => {
      const mockRes = mockResponse();

      const stream = createSSEStream(mockRes);
      stream.sendHeartbeat();
      stream.close();

      expect(mockRes.write).toHaveBeenCalledTimes(3); // init, heartbeat, close comment
      expect(mockRes.end).toHaveBeenCalledTimes(1);
    });
  });

  describe('sendJSONResponse', () => {
    it('sets correct content type header', () => {
      const mockRes = mockResponse();
      const response: JSONRPCResponse = {
        jsonrpc: '2.0',
        id: 1,
        result: { success: true },
      };

      sendJSONResponse(mockRes, response);

      expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
    });

    it('sends response as JSON', () => {
      const mockRes = mockResponse();
      const response: JSONRPCResponse = {
        jsonrpc: '2.0',
        id: 1,
        result: { success: true },
      };

      sendJSONResponse(mockRes, response);

      expect(mockRes.json).toHaveBeenCalledWith(response);
    });

    it('handles response with error', () => {
      const mockRes = mockResponse();
      const response: JSONRPCResponse = {
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32600,
          message: 'Invalid Request',
        },
      };

      sendJSONResponse(mockRes, response);

      expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
      expect(mockRes.json).toHaveBeenCalledWith(response);
    });

    it('handles response with null id', () => {
      const mockRes = mockResponse();
      const response: JSONRPCResponse = {
        jsonrpc: '2.0',
        id: null,
        result: { data: 'test' },
      };

      sendJSONResponse(mockRes, response);

      expect(mockRes.json).toHaveBeenCalledWith(response);
    });

    it('handles response with string id', () => {
      const mockRes = mockResponse();
      const response: JSONRPCResponse = {
        jsonrpc: '2.0',
        id: 'request-123',
        result: { data: 'test' },
      };

      sendJSONResponse(mockRes, response);

      expect(mockRes.json).toHaveBeenCalledWith(response);
    });

    it('handles complex nested result', () => {
      const mockRes = mockResponse();
      const response: JSONRPCResponse = {
        jsonrpc: '2.0',
        id: 1,
        result: {
          nested: {
            deeply: {
              structure: {
                with: ['arrays', 'and', 'objects'],
              },
            },
          },
        },
      };

      sendJSONResponse(mockRes, response);

      expect(mockRes.json).toHaveBeenCalledWith(response);
    });

    it('can be called multiple times on same response object', () => {
      const mockRes = mockResponse();
      const response: JSONRPCResponse = {
        jsonrpc: '2.0',
        id: 1,
        result: { count: 1 },
      };

      sendJSONResponse(mockRes, response);
      sendJSONResponse(mockRes, response);

      expect(mockRes.setHeader).toHaveBeenCalledTimes(2);
      expect(mockRes.json).toHaveBeenCalledTimes(2);
    });
  });
});
