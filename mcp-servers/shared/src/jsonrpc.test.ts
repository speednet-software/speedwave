import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSONRPCHandler, JSONRPCErrorBuilder } from './jsonrpc.js';
import { JSONRPCErrorCode } from './types.js';

describe('jsonrpc', () => {
  describe('JSONRPCErrorBuilder', () => {
    it('creates parse error', () => {
      const error = JSONRPCErrorBuilder.parseError();
      expect(error.code).toBe(JSONRPCErrorCode.ParseError);
      expect(error.message).toBe('Parse error');
    });

    it('creates parse error with custom message', () => {
      const error = JSONRPCErrorBuilder.parseError('Custom parse error');
      expect(error.message).toBe('Custom parse error');
    });

    it('creates invalid request error', () => {
      const error = JSONRPCErrorBuilder.invalidRequest();
      expect(error.code).toBe(JSONRPCErrorCode.InvalidRequest);
      expect(error.message).toBe('Invalid Request');
    });

    it('creates method not found error', () => {
      const error = JSONRPCErrorBuilder.methodNotFound('unknown_method');
      expect(error.code).toBe(JSONRPCErrorCode.MethodNotFound);
      expect(error.message).toContain('unknown_method');
    });

    it('creates invalid params error', () => {
      const error = JSONRPCErrorBuilder.invalidParams('Missing required field');
      expect(error.code).toBe(JSONRPCErrorCode.InvalidParams);
      expect(error.message).toBe('Missing required field');
    });

    it('creates internal error with generic message (no info leak)', () => {
      const originalError = new Error('ECONNREFUSED 10.0.0.5:5432 - PostgreSQL connection failed');
      const error = JSONRPCErrorBuilder.internalError(originalError);
      expect(error.code).toBe(JSONRPCErrorCode.InternalError);
      expect(error.message).toBe('Internal error');
      expect(error.message).not.toContain('PostgreSQL');
      expect(error.message).not.toContain('ECONNREFUSED');
    });

    it('creates session error', () => {
      const error = JSONRPCErrorBuilder.sessionError();
      expect(error.code).toBe(JSONRPCErrorCode.SessionError);
    });
  });

  describe('JSONRPCHandler', () => {
    let handler: JSONRPCHandler;

    beforeEach(() => {
      // Suppress console.log during tests
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      handler = new JSONRPCHandler({
        name: 'test-server',
        version: '1.0.0',
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    describe('registerTool', () => {
      it('registers a valid tool', () => {
        const tool = {
          name: 'test_tool',
          description: 'A test tool',
          inputSchema: { type: 'object' as const, properties: {} },
        };
        const toolHandler = vi.fn().mockResolvedValue({ content: [] });

        expect(() => handler.registerTool(tool, toolHandler)).not.toThrow();
        expect(handler.getTools()).toHaveLength(1);
        expect(handler.getTools()[0].name).toBe('test_tool');
      });

      it('rejects tool with invalid name', () => {
        const tool = {
          name: 'invalid tool name',
          description: 'Invalid',
          inputSchema: { type: 'object' as const, properties: {} },
        };
        const toolHandler = vi.fn();

        expect(() => handler.registerTool(tool, toolHandler)).toThrow('Invalid tool name');
      });

      it('registers multiple tools', () => {
        const tool1 = {
          name: 'tool_one',
          description: 'First tool',
          inputSchema: { type: 'object' as const, properties: {} },
        };
        const tool2 = {
          name: 'tool_two',
          description: 'Second tool',
          inputSchema: { type: 'object' as const, properties: {} },
        };

        handler.registerTool(tool1, vi.fn());
        handler.registerTool(tool2, vi.fn());

        expect(handler.getTools()).toHaveLength(2);
      });
    });

    describe('getServerInfo', () => {
      it('returns server info', () => {
        const info = handler.getServerInfo();
        expect(info.name).toBe('test-server');
        expect(info.version).toBe('1.0.0');
      });
    });

    describe('processRequest', () => {
      it('rejects invalid JSON-RPC message', async () => {
        const response = await handler.processRequest({ invalid: 'message' }, null);
        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(JSONRPCErrorCode.InvalidRequest);
      });

      it('handles initialize request', async () => {
        const request = {
          jsonrpc: '2.0',
          method: 'initialize',
          id: 1,
          params: {
            protocolVersion: '2024-11-05',
            clientInfo: {
              name: 'test-client',
              version: '1.0.0',
            },
            capabilities: {},
          },
        };

        const response = await handler.processRequest(request, null);

        expect(response.error).toBeUndefined();
        expect(response.result).toBeDefined();
        expect((response.result as Record<string, unknown>).protocolVersion).toBe('2024-11-05');
        expect((response.result as Record<string, unknown>)._meta).toBeDefined();
      });

      it('rejects unsupported protocol version', async () => {
        const request = {
          jsonrpc: '2.0',
          method: 'initialize',
          id: 1,
          params: {
            protocolVersion: '1999-01-01',
            clientInfo: {
              name: 'test-client',
              version: '1.0.0',
            },
            capabilities: {},
          },
        };

        const response = await handler.processRequest(request, null);

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(JSONRPCErrorCode.InvalidParams);
      });

      it('handles notifications/initialized', async () => {
        const request = {
          jsonrpc: '2.0',
          method: 'notifications/initialized',
          id: 1,
        };

        const response = await handler.processRequest(request, null);

        expect(response.error).toBeUndefined();
        expect(response.result).toEqual({});
      });

      it('handles tools/list request', async () => {
        const tool = {
          name: 'test_tool',
          description: 'A test tool',
          inputSchema: { type: 'object' as const, properties: {} },
        };
        handler.registerTool(tool, vi.fn());

        const request = {
          jsonrpc: '2.0',
          method: 'tools/list',
          id: 1,
        };

        const response = await handler.processRequest(request, null);

        expect(response.error).toBeUndefined();
        expect((response.result as { tools: unknown[] }).tools).toHaveLength(1);
      });

      it('handles tools/call request successfully', async () => {
        const expectedResult = {
          content: [{ type: 'text', text: 'Success' }],
        };
        const tool = {
          name: 'echo_tool',
          description: 'Echoes input',
          inputSchema: { type: 'object' as const, properties: {} },
        };
        const toolHandler = vi.fn().mockResolvedValue(expectedResult);
        handler.registerTool(tool, toolHandler);

        const request = {
          jsonrpc: '2.0',
          method: 'tools/call',
          id: 1,
          params: {
            name: 'echo_tool',
            arguments: { message: 'hello' },
          },
        };

        const response = await handler.processRequest(request, null);

        expect(response.error).toBeUndefined();
        expect(response.result).toEqual(expectedResult);
        expect(toolHandler).toHaveBeenCalledWith({ message: 'hello' });
      });

      it('returns error for unknown tool', async () => {
        const request = {
          jsonrpc: '2.0',
          method: 'tools/call',
          id: 1,
          params: {
            name: 'unknown_tool',
            arguments: {},
          },
        };

        const response = await handler.processRequest(request, null);

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(JSONRPCErrorCode.MethodNotFound);
      });

      it('returns error for invalid tool name in call', async () => {
        const request = {
          jsonrpc: '2.0',
          method: 'tools/call',
          id: 1,
          params: {
            name: 'invalid tool; rm -rf /',
            arguments: {},
          },
        };

        const response = await handler.processRequest(request, null);

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(JSONRPCErrorCode.InvalidParams);
      });

      it('handles tool execution errors', async () => {
        const tool = {
          name: 'failing_tool',
          description: 'Always fails',
          inputSchema: { type: 'object' as const, properties: {} },
        };
        const toolHandler = vi.fn().mockRejectedValue(new Error('Tool execution failed'));
        handler.registerTool(tool, toolHandler);

        const request = {
          jsonrpc: '2.0',
          method: 'tools/call',
          id: 1,
          params: {
            name: 'failing_tool',
            arguments: {},
          },
        };

        const response = await handler.processRequest(request, null);

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(JSONRPCErrorCode.InternalError);
      });

      it('returns method not found for unknown methods', async () => {
        const request = {
          jsonrpc: '2.0',
          method: 'unknown/method',
          id: 1,
        };

        const response = await handler.processRequest(request, null);

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(JSONRPCErrorCode.MethodNotFound);
        expect(response.error?.message).toContain('unknown/method');
      });
    });

    describe('initialize param validation', () => {
      it('returns invalidParams when initialize has no params', async () => {
        const request = { jsonrpc: '2.0', method: 'initialize', id: 1 };
        const response = await handler.processRequest(request, null);
        expect(response.error?.code).toBe(JSONRPCErrorCode.InvalidParams);
        expect(response.error?.message).toContain('params');
      });

      it('returns invalidParams when protocolVersion missing', async () => {
        const request = {
          jsonrpc: '2.0',
          method: 'initialize',
          id: 1,
          params: { clientInfo: { name: 'test', version: '1.0' }, capabilities: {} },
        };
        const response = await handler.processRequest(request, null);
        expect(response.error?.code).toBe(JSONRPCErrorCode.InvalidParams);
      });

      it('returns invalidParams when clientInfo missing', async () => {
        const request = {
          jsonrpc: '2.0',
          method: 'initialize',
          id: 1,
          params: { protocolVersion: '2024-11-05', capabilities: {} },
        };
        const response = await handler.processRequest(request, null);
        expect(response.error?.code).toBe(JSONRPCErrorCode.InvalidParams);
      });

      it('returns invalidParams when clientInfo.name is not a string', async () => {
        const request = {
          jsonrpc: '2.0',
          method: 'initialize',
          id: 1,
          params: {
            protocolVersion: '2024-11-05',
            clientInfo: { name: 123, version: '1.0' },
            capabilities: {},
          },
        };
        const response = await handler.processRequest(request, null);
        expect(response.error?.code).toBe(JSONRPCErrorCode.InvalidParams);
      });

      it('returns invalidParams when clientInfo.version is not a string', async () => {
        const request = {
          jsonrpc: '2.0',
          method: 'initialize',
          id: 1,
          params: {
            protocolVersion: '2024-11-05',
            clientInfo: { name: 'test', version: null },
            capabilities: {},
          },
        };
        const response = await handler.processRequest(request, null);
        expect(response.error?.code).toBe(JSONRPCErrorCode.InvalidParams);
      });
    });

    describe('tools/call param validation', () => {
      it('returns invalidParams when tools/call has no params', async () => {
        const request = { jsonrpc: '2.0', method: 'tools/call', id: 1 };
        const response = await handler.processRequest(request, null);
        expect(response.error?.code).toBe(JSONRPCErrorCode.InvalidParams);
      });

      it('returns invalidParams when params.name is not a string', async () => {
        const request = {
          jsonrpc: '2.0',
          method: 'tools/call',
          id: 1,
          params: { name: 123, arguments: {} },
        };
        const response = await handler.processRequest(request, null);
        expect(response.error?.code).toBe(JSONRPCErrorCode.InvalidParams);
      });

      it('handles missing arguments gracefully (defaults to empty object)', async () => {
        const tool = {
          name: 'no_args_tool',
          description: 'No args',
          inputSchema: { type: 'object' as const, properties: {} },
        };
        const toolHandler = vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'OK' }],
        });
        handler.registerTool(tool, toolHandler);

        const request = {
          jsonrpc: '2.0',
          method: 'tools/call',
          id: 1,
          params: { name: 'no_args_tool' },
        };
        const response = await handler.processRequest(request, null);
        expect(response.error).toBeUndefined();
        expect(toolHandler).toHaveBeenCalledWith({});
      });

      it.each(['a string', 42, true, [1, 2, 3]])(
        'defaults non-object arguments (%j) to empty object',
        async (invalidArgs) => {
          const tool = {
            name: 'args_tool',
            description: 'Tool with args',
            inputSchema: { type: 'object' as const, properties: {} },
          };
          const toolHandler = vi.fn().mockResolvedValue({
            content: [{ type: 'text', text: 'OK' }],
          });
          handler.registerTool(tool, toolHandler);

          const request = {
            jsonrpc: '2.0',
            method: 'tools/call',
            id: 1,
            params: { name: 'args_tool', arguments: invalidArgs },
          };
          const response = await handler.processRequest(request, null);
          expect(response.error).toBeUndefined();
          expect(toolHandler).toHaveBeenCalledWith({});
        }
      );
    });

    describe('internal error sanitization', () => {
      it('does not leak error details to client on tool failure', async () => {
        const tool = {
          name: 'leaky_tool',
          description: 'Throws detailed errors',
          inputSchema: { type: 'object' as const, properties: {} },
        };
        handler.registerTool(
          tool,
          vi.fn().mockRejectedValue(new Error('ECONNREFUSED 10.0.0.5:5432'))
        );

        const request = {
          jsonrpc: '2.0',
          method: 'tools/call',
          id: 1,
          params: { name: 'leaky_tool', arguments: {} },
        };
        const response = await handler.processRequest(request, null);
        expect(response.error?.message).toBe('Internal error');
        expect(response.error?.message).not.toContain('ECONNREFUSED');
      });
    });
  });
});
