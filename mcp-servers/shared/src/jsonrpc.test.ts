import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSONRPCHandler, JSONRPCErrorBuilder } from './jsonrpc.js';
import type { ProcessRequestResult } from './types.js';
import { JSONRPCErrorCode, SUPPORTED_PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION } from './types.js';

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
        const result = await handler.processRequest({ invalid: 'message' }, null);
        expect(result.response).not.toBeNull();
        expect(result.response!.error).toBeDefined();
        expect(result.response!.error?.code).toBe(JSONRPCErrorCode.InvalidRequest);
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

        const result = await handler.processRequest(request, null);

        expect(result.response).not.toBeNull();
        expect(result.response!.error).toBeUndefined();
        expect(result.response!.result).toBeDefined();
        const initResult = result.response!.result as Record<string, unknown>;
        expect(initResult.protocolVersion).toBe('2024-11-05');
        // Session ID is now returned separately, not in _meta
        expect(result.sessionId).toBeDefined();
        expect(typeof result.sessionId).toBe('string');
      });

      it('initialize includes logging capability', async () => {
        const request = {
          jsonrpc: '2.0',
          method: 'initialize',
          id: 1,
          params: {
            protocolVersion: '2024-11-05',
            clientInfo: { name: 'test-client', version: '1.0.0' },
            capabilities: {},
          },
        };

        const result = await handler.processRequest(request, null);
        const initResult = result.response!.result as Record<string, unknown>;
        const capabilities = initResult.capabilities as Record<string, unknown>;
        expect(capabilities.logging).toEqual({});
        expect(capabilities.tools).toEqual({ listChanged: false });
      });

      it('initialize includes instructions when configured', async () => {
        const handlerWithInstructions = new JSONRPCHandler({
          name: 'test-server',
          version: '1.0.0',
          instructions: 'This server provides useful tools.',
        });

        const request = {
          jsonrpc: '2.0',
          method: 'initialize',
          id: 1,
          params: {
            protocolVersion: '2024-11-05',
            clientInfo: { name: 'test-client', version: '1.0.0' },
            capabilities: {},
          },
        };

        const result = await handlerWithInstructions.processRequest(request, null);
        const initResult = result.response!.result as Record<string, unknown>;
        expect(initResult.instructions).toBe('This server provides useful tools.');
      });

      it('initialize omits instructions when not configured', async () => {
        const request = {
          jsonrpc: '2.0',
          method: 'initialize',
          id: 1,
          params: {
            protocolVersion: '2024-11-05',
            clientInfo: { name: 'test-client', version: '1.0.0' },
            capabilities: {},
          },
        };

        const result = await handler.processRequest(request, null);
        const initResult = result.response!.result as Record<string, unknown>;
        expect(initResult.instructions).toBeUndefined();
      });

      it('falls back to LATEST_PROTOCOL_VERSION for unsupported version', async () => {
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

        const result = await handler.processRequest(request, null);

        expect(result.response).not.toBeNull();
        expect(result.response!.error).toBeUndefined();
        const initResult = result.response!.result as Record<string, unknown>;
        expect(initResult.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
      });

      it('falls back to LATEST_PROTOCOL_VERSION for version 2025-06-18 (not in supported list)', async () => {
        const request = {
          jsonrpc: '2.0',
          method: 'initialize',
          id: 1,
          params: {
            protocolVersion: '2025-06-18',
            clientInfo: { name: 'test-client', version: '1.0.0' },
            capabilities: {},
          },
        };

        const result = await handler.processRequest(request, null);
        expect(result.response!.error).toBeUndefined();
        const initResult = result.response!.result as Record<string, unknown>;
        expect(initResult.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
      });

      it('falls back to LATEST_PROTOCOL_VERSION for unknown future version 2099-01-01', async () => {
        const request = {
          jsonrpc: '2.0',
          method: 'initialize',
          id: 1,
          params: {
            protocolVersion: '2099-01-01',
            clientInfo: { name: 'test-client', version: '1.0.0' },
            capabilities: {},
          },
        };

        const result = await handler.processRequest(request, null);
        expect(result.response).not.toBeNull();
        expect(result.response!.error).toBeUndefined();
        const initResult = result.response!.result as Record<string, unknown>;
        expect(initResult.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
      });

      it('accepts protocol version 2025-11-25', async () => {
        const request = {
          jsonrpc: '2.0',
          method: 'initialize',
          id: 1,
          params: {
            protocolVersion: '2025-11-25',
            clientInfo: { name: 'test-client', version: '1.0.0' },
            capabilities: {},
          },
        };

        const result = await handler.processRequest(request, null);
        expect(result.response!.error).toBeUndefined();
        const initResult = result.response!.result as Record<string, unknown>;
        expect(initResult.protocolVersion).toBe('2025-11-25');
      });

      it('accepts protocol version 2025-03-26', async () => {
        const request = {
          jsonrpc: '2.0',
          method: 'initialize',
          id: 1,
          params: {
            protocolVersion: '2025-03-26',
            clientInfo: { name: 'test-client', version: '1.0.0' },
            capabilities: {},
          },
        };

        const result = await handler.processRequest(request, null);
        expect(result.response!.error).toBeUndefined();
        const initResult = result.response!.result as Record<string, unknown>;
        expect(initResult.protocolVersion).toBe('2025-03-26');
      });

      it('handles notifications/initialized as notification (no id) with null response', async () => {
        const notification = {
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        };

        const result = await handler.processRequest(notification, null);
        expect(result.response).toBeNull();
      });

      it('handles notifications/cancelled as notification with null response', async () => {
        const notification = {
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: 'req-42' },
        };

        const result = await handler.processRequest(notification, null);
        expect(result.response).toBeNull();
      });

      it('handles notifications/cancelled without requestId param', async () => {
        const notification = {
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
        };

        const result = await handler.processRequest(notification, null);
        expect(result.response).toBeNull();
      });

      it('handles unknown notification methods with null response', async () => {
        const notification = {
          jsonrpc: '2.0',
          method: 'notifications/unknown',
        };

        const result = await handler.processRequest(notification, null);
        expect(result.response).toBeNull();
      });

      it('handles non-notification method sent without id as notification', async () => {
        const notification = {
          jsonrpc: '2.0',
          method: 'tools/list',
        };

        const result = await handler.processRequest(notification, null);
        expect(result.response).toBeNull();
      });

      it('handles ping request', async () => {
        const request = {
          jsonrpc: '2.0',
          method: 'ping',
          id: 1,
        };

        const result = await handler.processRequest(request, null);
        expect(result.response).not.toBeNull();
        expect(result.response!.error).toBeUndefined();
        expect(result.response!.result).toEqual({});
        expect(result.response!.id).toBe(1);
      });

      it('handles logging/setLevel request', async () => {
        const request = {
          jsonrpc: '2.0',
          method: 'logging/setLevel',
          id: 1,
          params: { level: 'warning' },
        };

        const result = await handler.processRequest(request, null);
        expect(result.response).not.toBeNull();
        expect(result.response!.error).toBeUndefined();
        expect(result.response!.result).toEqual({});
        expect(result.response!.id).toBe(1);
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

        const result = await handler.processRequest(request, null);

        expect(result.response).not.toBeNull();
        expect(result.response!.error).toBeUndefined();
        expect((result.response!.result as { tools: unknown[] }).tools).toHaveLength(1);
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

        const result = await handler.processRequest(request, null);

        expect(result.response).not.toBeNull();
        expect(result.response!.error).toBeUndefined();
        expect(result.response!.result).toEqual(expectedResult);
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

        const result = await handler.processRequest(request, null);

        expect(result.response).not.toBeNull();
        expect(result.response!.error).toBeDefined();
        expect(result.response!.error?.code).toBe(JSONRPCErrorCode.MethodNotFound);
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

        const result = await handler.processRequest(request, null);

        expect(result.response).not.toBeNull();
        expect(result.response!.error).toBeDefined();
        expect(result.response!.error?.code).toBe(JSONRPCErrorCode.InvalidParams);
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

        const result = await handler.processRequest(request, null);

        expect(result.response).not.toBeNull();
        expect(result.response!.error).toBeDefined();
        expect(result.response!.error?.code).toBe(JSONRPCErrorCode.InternalError);
      });

      it('returns method not found for unknown methods', async () => {
        const request = {
          jsonrpc: '2.0',
          method: 'unknown/method',
          id: 1,
        };

        const result = await handler.processRequest(request, null);

        expect(result.response).not.toBeNull();
        expect(result.response!.error).toBeDefined();
        expect(result.response!.error?.code).toBe(JSONRPCErrorCode.MethodNotFound);
        expect(result.response!.error?.message).toContain('unknown/method');
      });
    });

    describe('initialize param validation', () => {
      it('returns invalidParams when initialize has no params', async () => {
        const request = { jsonrpc: '2.0', method: 'initialize', id: 1 };
        const result = await handler.processRequest(request, null);
        expect(result.response!.error?.code).toBe(JSONRPCErrorCode.InvalidParams);
        expect(result.response!.error?.message).toContain('params');
      });

      it('returns invalidParams when protocolVersion missing', async () => {
        const request = {
          jsonrpc: '2.0',
          method: 'initialize',
          id: 1,
          params: { clientInfo: { name: 'test', version: '1.0' }, capabilities: {} },
        };
        const result = await handler.processRequest(request, null);
        expect(result.response!.error?.code).toBe(JSONRPCErrorCode.InvalidParams);
      });

      it('returns invalidParams when clientInfo missing', async () => {
        const request = {
          jsonrpc: '2.0',
          method: 'initialize',
          id: 1,
          params: { protocolVersion: '2024-11-05', capabilities: {} },
        };
        const result = await handler.processRequest(request, null);
        expect(result.response!.error?.code).toBe(JSONRPCErrorCode.InvalidParams);
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
        const result = await handler.processRequest(request, null);
        expect(result.response!.error?.code).toBe(JSONRPCErrorCode.InvalidParams);
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
        const result = await handler.processRequest(request, null);
        expect(result.response!.error?.code).toBe(JSONRPCErrorCode.InvalidParams);
      });
    });

    describe('tools/call param validation', () => {
      it('returns invalidParams when tools/call has no params', async () => {
        const request = { jsonrpc: '2.0', method: 'tools/call', id: 1 };
        const result = await handler.processRequest(request, null);
        expect(result.response!.error?.code).toBe(JSONRPCErrorCode.InvalidParams);
      });

      it('returns invalidParams when params.name is not a string', async () => {
        const request = {
          jsonrpc: '2.0',
          method: 'tools/call',
          id: 1,
          params: { name: 123, arguments: {} },
        };
        const result = await handler.processRequest(request, null);
        expect(result.response!.error?.code).toBe(JSONRPCErrorCode.InvalidParams);
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
        const result = await handler.processRequest(request, null);
        expect(result.response!.error).toBeUndefined();
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
          const result = await handler.processRequest(request, null);
          expect(result.response!.error).toBeUndefined();
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
        const result = await handler.processRequest(request, null);
        expect(result.response!.error?.message).toBe('Internal error');
        expect(result.response!.error?.message).not.toContain('ECONNREFUSED');
      });
    });

    describe('tools/list pagination', () => {
      function registerNTools(h: JSONRPCHandler, count: number): void {
        for (let i = 0; i < count; i++) {
          h.registerTool(
            {
              name: `tool_${String(i).padStart(4, '0')}`,
              description: `Tool ${i}`,
              inputSchema: { type: 'object' as const, properties: {} },
            },
            vi.fn().mockResolvedValue({ content: [] })
          );
        }
      }

      it('returns all tools without cursor when count is under page size', async () => {
        registerNTools(handler, 5);
        const request = { jsonrpc: '2.0', method: 'tools/list', id: 1 };

        const result = await handler.processRequest(request, null);
        const listResult = result.response!.result as { tools: unknown[]; nextCursor?: string };

        expect(listResult.tools).toHaveLength(5);
        expect(listResult.nextCursor).toBeUndefined();
      });

      it('returns first page with nextCursor when more than 100 tools', async () => {
        registerNTools(handler, 150);
        const request = { jsonrpc: '2.0', method: 'tools/list', id: 1 };

        const result = await handler.processRequest(request, null);
        const listResult = result.response!.result as { tools: unknown[]; nextCursor?: string };

        expect(listResult.tools).toHaveLength(100);
        expect(listResult.nextCursor).toBeDefined();
        // Decode cursor to verify it points to index 100
        expect(Buffer.from(listResult.nextCursor!, 'base64').toString()).toBe('100');
      });

      it('returns second page when using cursor from first page', async () => {
        registerNTools(handler, 150);
        // First page
        const firstResult = await handler.processRequest(
          { jsonrpc: '2.0', method: 'tools/list', id: 1 },
          null
        );
        const firstPage = firstResult.response!.result as {
          tools: unknown[];
          nextCursor?: string;
        };

        // Second page using cursor
        const secondResult = await handler.processRequest(
          {
            jsonrpc: '2.0',
            method: 'tools/list',
            id: 2,
            params: { cursor: firstPage.nextCursor },
          },
          null
        );
        const secondPage = secondResult.response!.result as {
          tools: unknown[];
          nextCursor?: string;
        };

        expect(secondPage.tools).toHaveLength(50);
        expect(secondPage.nextCursor).toBeUndefined();
      });

      it('returns empty page when cursor points past end', async () => {
        registerNTools(handler, 5);
        const cursor = Buffer.from('999').toString('base64');
        const request = {
          jsonrpc: '2.0',
          method: 'tools/list',
          id: 1,
          params: { cursor },
        };

        const result = await handler.processRequest(request, null);
        const listResult = result.response!.result as { tools: unknown[]; nextCursor?: string };

        expect(listResult.tools).toHaveLength(0);
        expect(listResult.nextCursor).toBeUndefined();
      });

      it('returns exactly 100 tools on last full page without nextCursor', async () => {
        registerNTools(handler, 100);
        const request = { jsonrpc: '2.0', method: 'tools/list', id: 1 };

        const result = await handler.processRequest(request, null);
        const listResult = result.response!.result as { tools: unknown[]; nextCursor?: string };

        expect(listResult.tools).toHaveLength(100);
        expect(listResult.nextCursor).toBeUndefined();
      });

      it('returns empty list with no cursor when no tools registered', async () => {
        const request = { jsonrpc: '2.0', method: 'tools/list', id: 1 };

        const result = await handler.processRequest(request, null);
        const listResult = result.response!.result as { tools: unknown[]; nextCursor?: string };

        expect(listResult.tools).toHaveLength(0);
        expect(listResult.nextCursor).toBeUndefined();
      });

      it('returns invalidParams error for malformed cursor (non-numeric base64)', async () => {
        registerNTools(handler, 5);
        const cursor = Buffer.from('not-a-number').toString('base64');
        const request = {
          jsonrpc: '2.0',
          method: 'tools/list',
          id: 1,
          params: { cursor },
        };

        const result = await handler.processRequest(request, null);
        expect(result.response!.error).toBeDefined();
        expect(result.response!.error?.code).toBe(JSONRPCErrorCode.InvalidParams);
        expect(result.response!.error?.message).toContain('Invalid cursor');
      });

      it('returns invalidParams error for cursor encoding a negative number', async () => {
        registerNTools(handler, 5);
        const cursor = Buffer.from('-5').toString('base64');
        const request = {
          jsonrpc: '2.0',
          method: 'tools/list',
          id: 1,
          params: { cursor },
        };

        const result = await handler.processRequest(request, null);
        expect(result.response!.error).toBeDefined();
        expect(result.response!.error?.code).toBe(JSONRPCErrorCode.InvalidParams);
        expect(result.response!.error?.message).toContain('Invalid cursor');
      });

      it('treats empty string cursor as no cursor (returns all tools)', async () => {
        registerNTools(handler, 5);
        const cursor = Buffer.from('').toString('base64');
        const request = {
          jsonrpc: '2.0',
          method: 'tools/list',
          id: 1,
          params: { cursor },
        };

        const result = await handler.processRequest(request, null);
        // Empty base64 encodes to empty string, which is falsy — treated as no cursor
        expect(result.response!.error).toBeUndefined();
        const listResult = result.response!.result as { tools: unknown[] };
        expect(listResult.tools).toHaveLength(5);
      });

      it('returns invalidParams error for cursor with non-integer base64 content', async () => {
        registerNTools(handler, 5);
        // "abc" is valid base64 that decodes to binary gibberish, parseInt returns NaN
        const cursor = 'abc';
        const request = {
          jsonrpc: '2.0',
          method: 'tools/list',
          id: 1,
          params: { cursor },
        };

        const result = await handler.processRequest(request, null);
        expect(result.response!.error).toBeDefined();
        expect(result.response!.error?.code).toBe(JSONRPCErrorCode.InvalidParams);
      });

      it('accepts valid cursor encoding zero', async () => {
        registerNTools(handler, 5);
        const cursor = Buffer.from('0').toString('base64');
        const request = {
          jsonrpc: '2.0',
          method: 'tools/list',
          id: 1,
          params: { cursor },
        };

        const result = await handler.processRequest(request, null);
        expect(result.response!.error).toBeUndefined();
        const listResult = result.response!.result as { tools: unknown[] };
        expect(listResult.tools).toHaveLength(5);
      });
    });

    describe('ProcessRequestResult shape', () => {
      it('wraps all responses in ProcessRequestResult with response field', async () => {
        const request = {
          jsonrpc: '2.0',
          method: 'tools/list',
          id: 1,
        };

        const result: ProcessRequestResult = await handler.processRequest(request, null);
        expect(result).toHaveProperty('response');
        expect(result.response).toHaveProperty('jsonrpc', '2.0');
      });

      it('returns sessionId only for initialize', async () => {
        // tools/list should not have sessionId
        const listResult = await handler.processRequest(
          { jsonrpc: '2.0', method: 'tools/list', id: 1 },
          null
        );
        expect(listResult.sessionId).toBeUndefined();

        // ping should not have sessionId
        const pingResult = await handler.processRequest(
          { jsonrpc: '2.0', method: 'ping', id: 2 },
          null
        );
        expect(pingResult.sessionId).toBeUndefined();

        // initialize should have sessionId
        const initResult = await handler.processRequest(
          {
            jsonrpc: '2.0',
            method: 'initialize',
            id: 3,
            params: {
              protocolVersion: '2024-11-05',
              clientInfo: { name: 'test', version: '1.0' },
              capabilities: {},
            },
          },
          null
        );
        expect(initResult.sessionId).toBeDefined();
      });
    });
  });

  describe('SUPPORTED_PROTOCOL_VERSIONS', () => {
    it('contains expected versions in order', () => {
      expect(SUPPORTED_PROTOCOL_VERSIONS).toEqual(['2024-11-05', '2025-03-26', '2025-11-25']);
    });

    it('does not contain removed version 2025-06-18', () => {
      expect(SUPPORTED_PROTOCOL_VERSIONS).not.toContain('2025-06-18');
    });

    it('is a frozen array (readonly)', () => {
      expect(Object.isFrozen(SUPPORTED_PROTOCOL_VERSIONS)).toBe(true);
    });
  });

  describe('LATEST_PROTOCOL_VERSION', () => {
    it('equals the last entry in SUPPORTED_PROTOCOL_VERSIONS', () => {
      expect(LATEST_PROTOCOL_VERSION).toBe(
        SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1]
      );
    });

    it('is 2025-11-25', () => {
      expect(LATEST_PROTOCOL_VERSION).toBe('2025-11-25');
    });
  });
});
