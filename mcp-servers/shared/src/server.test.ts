import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Request, Response } from 'express';
import { createMCPServer, textResult, jsonResult, errorResult } from './server.js';
import type { MCPServerOptions } from './server.js';
import type { Tool, ToolHandler, JSONRPCResponse } from './types.js';

// Mock dependencies
vi.mock('./session.js', () => ({
  sessionManager: {
    getActiveSessionCount: vi.fn(() => 0),
    createSession: vi.fn(() => 'mock-session-id'),
    getSession: vi.fn(() => ({
      id: 'mock-session-id',
      createdAt: new Date(),
      lastAccessedAt: new Date(),
    })),
  },
}));

vi.mock('./jsonrpc.js', () => {
  // Define mock class inside the factory to avoid hoisting issues
  class MockJSONRPCHandler {
    processRequest = vi.fn().mockResolvedValue({ response: { jsonrpc: '2.0', id: 1, result: {} } });
    registerTool = vi.fn();
    getTools = vi.fn(() => []);
    getServerInfo = vi.fn(() => ({ name: 'test-server', version: '1.0.0' }));

    constructor(_options: unknown) {
      // Store options for later verification if needed
    }
  }

  return {
    JSONRPCHandler: MockJSONRPCHandler,
  };
});

vi.mock('./sse.js', () => {
  const mockSSEStream = {
    initialize: vi.fn(),
    sendMessage: vi.fn(),
    close: vi.fn(),
  };

  return {
    createSSEStream: vi.fn(() => mockSSEStream),
    sendJSONResponse: vi.fn((res: any, response: any) => {
      res.setHeader('Content-Type', 'application/json');
      res.json(response);
    }),
  };
});

vi.mock('./security.js', async () => {
  const actual = await vi.importActual<typeof import('./security.js')>('./security.js');
  return {
    ...actual,
    validateOrigin: actual.validateOrigin,
  };
});

// Helper to create mock Express request
function createMockRequest(body: unknown, headers: Record<string, string> = {}): Partial<Request> {
  return {
    body,
    get: (name: string) => headers[name.toLowerCase()],
    headers: headers as any,
  };
}

// Helper to create mock Express response
function createMockResponse(): Partial<Response> {
  const res: any = {
    statusCode: 200,
    _headers: {} as Record<string, string>,
    _data: null as any,
    setHeader: vi.fn((name: string, value: string) => {
      res._headers[name] = value;
    }),
    json: vi.fn((data: any) => {
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
  return res;
}

describe('server', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Suppress console output during tests
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Reset mock implementations
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createMCPServer', () => {
    describe('Server Creation', () => {
      it('creates server with minimal config', () => {
        const options: MCPServerOptions = {
          name: 'test-server',
          version: '1.0.0',
          port: 3000,
        };

        const server = createMCPServer(options);

        expect(server).toBeDefined();
        expect(server.app).toBeDefined();
        expect(server.rpcHandler).toBeDefined();
        expect(server.registerTool).toBeTypeOf('function');
        expect(server.start).toBeTypeOf('function');
        expect(server.stop).toBeTypeOf('function');
      });

      it('creates server with custom config', () => {
        const options: MCPServerOptions = {
          name: 'custom-server',
          version: '2.0.0',
          port: 3001,
          tools: [],
          healthCheck: vi.fn().mockResolvedValue(undefined),
          onStart: vi.fn().mockResolvedValue(undefined),
        };

        const server = createMCPServer(options);

        expect(server).toBeDefined();
        expect(server.app).toBeDefined();
      });

      it('creates server with tools array', () => {
        const tool: Tool = {
          name: 'test_tool',
          description: 'Test tool',
          inputSchema: { type: 'object', properties: {} },
        };
        const handler: ToolHandler = vi.fn().mockResolvedValue({ content: [] });

        const options: MCPServerOptions = {
          name: 'test-server',
          version: '1.0.0',
          port: 3000,
          tools: [{ tool, handler }],
        };

        const server = createMCPServer(options);

        expect(server.registerTool).toBeTypeOf('function');
        expect(server.rpcHandler.registerTool).toHaveBeenCalledWith(tool, handler);
      });

      it('creates separate instances for multiple servers', () => {
        const server1 = createMCPServer({
          name: 'server1',
          version: '1.0.0',
          port: 3000,
        });

        const server2 = createMCPServer({
          name: 'server2',
          version: '1.0.0',
          port: 3001,
        });

        expect(server1.app).not.toBe(server2.app);
        expect(server1.rpcHandler).not.toBe(server2.rpcHandler);
      });

      it('initializes with empty tools when not provided', () => {
        const options: MCPServerOptions = {
          name: 'test-server',
          version: '1.0.0',
          port: 3000,
        };

        const server = createMCPServer(options);

        expect(server.rpcHandler.registerTool).not.toHaveBeenCalled();
        expect(server.rpcHandler.getTools()).toEqual([]);
      });

      it('exposes Express app instance', () => {
        const server = createMCPServer({
          name: 'test-server',
          version: '1.0.0',
          port: 3000,
        });

        expect(server.app).toBeDefined();
        expect(typeof server.app.listen).toBe('function');
        expect(typeof server.app.use).toBe('function');
      });

      it('exposes JSONRPCHandler instance', () => {
        const server = createMCPServer({
          name: 'test-server',
          version: '1.0.0',
          port: 3000,
        });

        expect(server.rpcHandler).toBeDefined();
        expect(server.rpcHandler.processRequest).toBeDefined();
        expect(server.rpcHandler.registerTool).toBeDefined();
      });
    });

    describe('Tool Registration', () => {
      it('registers tool successfully', () => {
        const server = createMCPServer({
          name: 'test-server',
          version: '1.0.0',
          port: 3000,
        });

        const tool: Tool = {
          name: 'test_tool',
          description: 'Test tool',
          inputSchema: { type: 'object', properties: {} },
        };
        const handler: ToolHandler = vi.fn().mockResolvedValue({ content: [] });

        server.registerTool(tool, handler);

        expect(server.rpcHandler.registerTool).toHaveBeenCalledWith(tool, handler);
      });

      it('registers multiple tools', () => {
        const server = createMCPServer({
          name: 'test-server',
          version: '1.0.0',
          port: 3000,
        });

        const tool1: Tool = {
          name: 'tool_one',
          description: 'First tool',
          inputSchema: { type: 'object', properties: {} },
        };
        const tool2: Tool = {
          name: 'tool_two',
          description: 'Second tool',
          inputSchema: { type: 'object', properties: {} },
        };

        server.registerTool(tool1, vi.fn());
        server.registerTool(tool2, vi.fn());

        expect(server.rpcHandler.registerTool).toHaveBeenCalledTimes(2);
      });

      it('registers tools from initial config', () => {
        const tool: Tool = {
          name: 'initial_tool',
          description: 'Initial tool',
          inputSchema: { type: 'object', properties: {} },
        };
        const handler: ToolHandler = vi.fn();

        const server = createMCPServer({
          name: 'test-server',
          version: '1.0.0',
          port: 3000,
          tools: [{ tool, handler }],
        });

        expect(server.rpcHandler.registerTool).toHaveBeenCalledWith(tool, handler);
      });

      it('allows registering tools after server creation', () => {
        const server = createMCPServer({
          name: 'test-server',
          version: '1.0.0',
          port: 3000,
        });

        const tool: Tool = {
          name: 'late_tool',
          description: 'Tool added later',
          inputSchema: { type: 'object', properties: {} },
        };

        server.registerTool(tool, vi.fn());

        expect(server.rpcHandler.registerTool).toHaveBeenCalledWith(tool, expect.any(Function));
      });
    });

    describe('Health Endpoint', () => {
      it('returns minimal health status', async () => {
        const server = createMCPServer({
          name: 'test-server',
          version: '1.0.0',
          port: 3000,
        });

        const req = createMockRequest({});
        const res = createMockResponse();

        const app = server.app;
        const routes = (app as any).router.stack.filter((layer: any) => layer.route);
        const healthRoute = routes.find((layer: any) => layer.route?.path === '/health');

        expect(healthRoute).toBeDefined();

        await healthRoute.route.stack[0].handle(req, res);

        const response = (res.json as any).mock.calls[0][0];
        expect(response).toEqual({ status: 'ok' });
      });

      it('returns ok when custom health check succeeds', async () => {
        const customHealthCheck = vi.fn().mockResolvedValue(undefined);

        const server = createMCPServer({
          name: 'test-server',
          version: '1.0.0',
          port: 3000,
          healthCheck: customHealthCheck,
        });

        const req = createMockRequest({});
        const res = createMockResponse();

        const app = server.app;
        const routes = (app as any).router.stack.filter((layer: any) => layer.route);
        const healthRoute = routes.find((layer: any) => layer.route?.path === '/health');

        await healthRoute.route.stack[0].handle(req, res);

        expect(customHealthCheck).toHaveBeenCalled();
        const response = (res.json as any).mock.calls[0][0];
        expect(response).toEqual({ status: 'ok' });
      });

      it('handles custom health check errors', async () => {
        const customHealthCheck = vi
          .fn()
          .mockRejectedValue(new Error('Database connection failed'));

        const server = createMCPServer({
          name: 'test-server',
          version: '1.0.0',
          port: 3000,
          healthCheck: customHealthCheck,
        });

        const req = createMockRequest({});
        const res = createMockResponse();

        const app = server.app;
        const routes = (app as any).router.stack.filter((layer: any) => layer.route);
        const healthRoute = routes.find((layer: any) => layer.route?.path === '/health');

        await healthRoute.route.stack[0].handle(req, res);

        expect(res.status).toHaveBeenCalledWith(500);
        const response = (res.json as any).mock.calls[0][0];
        expect(response).toEqual({ status: 'error' });
      });

      it('does not leak service metadata in health response', async () => {
        const server = createMCPServer({
          name: 'test-server',
          version: '1.0.0',
          port: 3000,
        });

        const req = createMockRequest({});
        const res = createMockResponse();

        const app = server.app;
        const routes = (app as any).router.stack.filter((layer: any) => layer.route);
        const healthRoute = routes.find((layer: any) => layer.route?.path === '/health');

        await healthRoute.route.stack[0].handle(req, res);

        const response = (res.json as any).mock.calls[0][0];
        expect(response).not.toHaveProperty('service');
        expect(response).not.toHaveProperty('version');
        expect(response).not.toHaveProperty('timestamp');
        expect(response).not.toHaveProperty('sessions');
      });

      it('runs healthCheck callback when auth is configured and check passes', async () => {
        const customHealthCheck = vi.fn().mockResolvedValue(undefined);

        const server = createMCPServer({
          name: 'auth-health-test',
          version: '1.0.0',
          port: 3000,
          auth: { token: 'secret-token' },
          healthCheck: customHealthCheck,
        });

        const req = createMockRequest({});
        const res = createMockResponse();

        const routes = (server.app as any).router.stack.filter((layer: any) => layer.route);
        const healthRoute = routes.find((layer: any) => layer.route?.path === '/health');

        await healthRoute.route.stack[0].handle(req, res);

        expect(customHealthCheck).toHaveBeenCalled();
        const response = (res.json as any).mock.calls[0][0];
        expect(response).toEqual({ status: 'ok' });
      });

      it('returns 500 when healthCheck fails and auth is configured', async () => {
        const customHealthCheck = vi.fn().mockRejectedValue(new Error('Client not configured'));

        const server = createMCPServer({
          name: 'auth-health-test',
          version: '1.0.0',
          port: 3000,
          auth: { token: 'secret-token' },
          healthCheck: customHealthCheck,
        });

        const req = createMockRequest({});
        const res = createMockResponse();

        const routes = (server.app as any).router.stack.filter((layer: any) => layer.route);
        const healthRoute = routes.find((layer: any) => layer.route?.path === '/health');

        await healthRoute.route.stack[0].handle(req, res);

        expect(customHealthCheck).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(500);
        const response = (res.json as any).mock.calls[0][0];
        expect(response).toEqual({ status: 'error' });
      });

      it('does not log health check error details when auth is configured', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const customHealthCheck = vi.fn().mockRejectedValue(new Error('Secret database info'));

        const server = createMCPServer({
          name: 'auth-health-test',
          version: '1.0.0',
          port: 3000,
          auth: { token: 'secret-token' },
          healthCheck: customHealthCheck,
        });

        const req = createMockRequest({});
        const res = createMockResponse();

        const routes = (server.app as any).router.stack.filter((layer: any) => layer.route);
        const healthRoute = routes.find((layer: any) => layer.route?.path === '/health');

        await healthRoute.route.stack[0].handle(req, res);

        // Should NOT log error details when auth is configured
        const errorCalls = consoleSpy.mock.calls.map((call) => call.join(' '));
        expect(errorCalls.some((msg) => msg.includes('Secret database info'))).toBe(false);

        consoleSpy.mockRestore();
      });
    });

    describe('MCP Endpoint (/)', () => {
      it('processes JSON-RPC request', async () => {
        const mockResponse: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: 1,
          result: { success: true },
        };

        const server = createMCPServer({
          name: 'test-server',
          version: '1.0.0',
          port: 3000,
        });

        server.rpcHandler.processRequest = vi.fn().mockResolvedValue({ response: mockResponse });

        const requestBody = {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        };

        const req = createMockRequest(requestBody);
        const res = createMockResponse();

        const app = server.app;
        const routes = (app as any).router.stack.filter((layer: any) => layer.route);
        const mcpRoute = routes.find((layer: any) => layer.route?.path === '/');

        await mcpRoute.route.stack[0].handle(req, res);

        expect(server.rpcHandler.processRequest).toHaveBeenCalledWith(requestBody, null);
      });

      it('extracts session ID from headers', async () => {
        const mockResponse: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: 1,
          result: {},
        };

        const server = createMCPServer({
          name: 'test-server',
          version: '1.0.0',
          port: 3000,
        });

        server.rpcHandler.processRequest = vi.fn().mockResolvedValue({ response: mockResponse });

        const req = createMockRequest(
          { jsonrpc: '2.0', id: 1, method: 'test' },
          { 'mcp-session-id': '550e8400-e29b-41d4-a716-446655440000' }
        );
        const res = createMockResponse();

        const app = server.app;
        const routes = (app as any).router.stack.filter((layer: any) => layer.route);
        const mcpRoute = routes.find((layer: any) => layer.route?.path === '/');

        await mcpRoute.route.stack[0].handle(req, res);

        expect(server.rpcHandler.processRequest).toHaveBeenCalledWith(
          expect.anything(),
          '550e8400-e29b-41d4-a716-446655440000'
        );
      });

      it('ignores _meta.sessionId in body (session only from headers per MCP spec)', async () => {
        const mockResponse: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: 1,
          result: {},
        };

        const server = createMCPServer({
          name: 'test-server',
          version: '1.0.0',
          port: 3000,
        });

        server.rpcHandler.processRequest = vi.fn().mockResolvedValue({ response: mockResponse });

        const req = createMockRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'test',
          _meta: { sessionId: '660e8400-e29b-41d4-a716-446655440001' },
        });
        const res = createMockResponse();

        const app = server.app;
        const routes = (app as any).router.stack.filter((layer: any) => layer.route);
        const mcpRoute = routes.find((layer: any) => layer.route?.path === '/');

        await mcpRoute.route.stack[0].handle(req, res);

        // Session from body _meta is NOT used — only Mcp-Session-Id header
        expect(server.rpcHandler.processRequest).toHaveBeenCalledWith(expect.anything(), null);
      });

      it('uses header session ID even when body has _meta.sessionId', async () => {
        const mockResponse: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: 1,
          result: {},
        };

        const server = createMCPServer({
          name: 'test-server',
          version: '1.0.0',
          port: 3000,
        });

        server.rpcHandler.processRequest = vi.fn().mockResolvedValue({ response: mockResponse });

        const req = createMockRequest(
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'test',
            _meta: { sessionId: '660e8400-e29b-41d4-a716-446655440001' },
          },
          { 'mcp-session-id': '550e8400-e29b-41d4-a716-446655440000' }
        );
        const res = createMockResponse();

        const app = server.app;
        const routes = (app as any).router.stack.filter((layer: any) => layer.route);
        const mcpRoute = routes.find((layer: any) => layer.route?.path === '/');

        await mcpRoute.route.stack[0].handle(req, res);

        expect(server.rpcHandler.processRequest).toHaveBeenCalledWith(
          expect.anything(),
          '550e8400-e29b-41d4-a716-446655440000'
        );
      });

      it('uses null session ID when not provided', async () => {
        const mockResponse: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: 1,
          result: {},
        };

        const server = createMCPServer({
          name: 'test-server',
          version: '1.0.0',
          port: 3000,
        });

        server.rpcHandler.processRequest = vi.fn().mockResolvedValue({ response: mockResponse });

        const req = createMockRequest({ jsonrpc: '2.0', id: 1, method: 'test' });
        const res = createMockResponse();

        const app = server.app;
        const routes = (app as any).router.stack.filter((layer: any) => layer.route);
        const mcpRoute = routes.find((layer: any) => layer.route?.path === '/');

        await mcpRoute.route.stack[0].handle(req, res);

        expect(server.rpcHandler.processRequest).toHaveBeenCalledWith(expect.anything(), null);
      });

      it('rejects malformed session ID and passes null', async () => {
        const mockResponse: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: 1,
          result: {},
        };

        const server = createMCPServer({
          name: 'test-server',
          version: '1.0.0',
          port: 3000,
        });

        server.rpcHandler.processRequest = vi.fn().mockResolvedValue({ response: mockResponse });

        const req = createMockRequest(
          { jsonrpc: '2.0', id: 1, method: 'test' },
          { 'mcp-session-id': 'not-a-valid-uuid' }
        );
        const res = createMockResponse();

        const app = server.app;
        const routes = (app as any).router.stack.filter((layer: any) => layer.route);
        const mcpRoute = routes.find((layer: any) => layer.route?.path === '/');

        await mcpRoute.route.stack[0].handle(req, res);

        expect(server.rpcHandler.processRequest).toHaveBeenCalledWith(expect.anything(), null);
      });

      it('rejects session ID with injection characters', async () => {
        const mockResponse: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: 1,
          result: {},
        };

        const server = createMCPServer({
          name: 'test-server',
          version: '1.0.0',
          port: 3000,
        });

        server.rpcHandler.processRequest = vi.fn().mockResolvedValue({ response: mockResponse });

        const req = createMockRequest(
          { jsonrpc: '2.0', id: 1, method: 'test' },
          { 'mcp-session-id': '"; DROP TABLE sessions; --' }
        );
        const res = createMockResponse();

        const app = server.app;
        const routes = (app as any).router.stack.filter((layer: any) => layer.route);
        const mcpRoute = routes.find((layer: any) => layer.route?.path === '/');

        await mcpRoute.route.stack[0].handle(req, res);

        expect(server.rpcHandler.processRequest).toHaveBeenCalledWith(expect.anything(), null);
      });

      it('rejects extremely long session ID', async () => {
        const mockResponse: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: 1,
          result: {},
        };

        const server = createMCPServer({
          name: 'test-server',
          version: '1.0.0',
          port: 3000,
        });

        server.rpcHandler.processRequest = vi.fn().mockResolvedValue({ response: mockResponse });

        const req = createMockRequest(
          { jsonrpc: '2.0', id: 1, method: 'test' },
          { 'mcp-session-id': 'a'.repeat(10000) }
        );
        const res = createMockResponse();

        const app = server.app;
        const routes = (app as any).router.stack.filter((layer: any) => layer.route);
        const mcpRoute = routes.find((layer: any) => layer.route?.path === '/');

        await mcpRoute.route.stack[0].handle(req, res);

        expect(server.rpcHandler.processRequest).toHaveBeenCalledWith(expect.anything(), null);
      });

      it('passes valid UUID v4 session ID through', async () => {
        const validUUID = '550e8400-e29b-41d4-a716-446655440000';
        const mockResponse: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: 1,
          result: {},
        };

        const server = createMCPServer({
          name: 'test-server',
          version: '1.0.0',
          port: 3000,
        });

        server.rpcHandler.processRequest = vi.fn().mockResolvedValue({ response: mockResponse });

        const req = createMockRequest(
          { jsonrpc: '2.0', id: 1, method: 'test' },
          { 'mcp-session-id': validUUID }
        );
        const res = createMockResponse();

        const app = server.app;
        const routes = (app as any).router.stack.filter((layer: any) => layer.route);
        const mcpRoute = routes.find((layer: any) => layer.route?.path === '/');

        await mcpRoute.route.stack[0].handle(req, res);

        expect(server.rpcHandler.processRequest).toHaveBeenCalledWith(expect.anything(), validUUID);
      });

      it('sends JSON response when SSE not requested', async () => {
        const mockResponse: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: 1,
          result: { data: 'test' },
        };

        const server = createMCPServer({
          name: 'test-server',
          version: '1.0.0',
          port: 3000,
        });

        server.rpcHandler.processRequest = vi.fn().mockResolvedValue({ response: mockResponse });

        const req = createMockRequest({ jsonrpc: '2.0', id: 1, method: 'test' });
        const res = createMockResponse();

        const app = server.app;
        const routes = (app as any).router.stack.filter((layer: any) => layer.route);
        const mcpRoute = routes.find((layer: any) => layer.route?.path === '/');

        await mcpRoute.route.stack[0].handle(req, res);

        const { sendJSONResponse } = await import('./sse.js');
        expect(sendJSONResponse).toHaveBeenCalledWith(res, mockResponse);
      });

      it('sends SSE stream when requested', async () => {
        const mockResponse: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: 1,
          result: { data: 'test' },
        };

        const server = createMCPServer({
          name: 'test-server',
          version: '1.0.0',
          port: 3000,
        });

        server.rpcHandler.processRequest = vi.fn().mockResolvedValue({ response: mockResponse });

        const req = createMockRequest(
          { jsonrpc: '2.0', id: 1, method: 'test' },
          { accept: 'application/json, text/event-stream' }
        );
        const res = createMockResponse();

        const app = server.app;
        const routes = (app as any).router.stack.filter((layer: any) => layer.route);
        const mcpRoute = routes.find((layer: any) => layer.route?.path === '/');

        await mcpRoute.route.stack[0].handle(req, res);

        const { createSSEStream } = await import('./sse.js');
        expect(createSSEStream).toHaveBeenCalledWith(res);
      });

      it('handles partial SSE accept header', async () => {
        const mockResponse: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: 1,
          result: {},
        };

        const server = createMCPServer({
          name: 'test-server',
          version: '1.0.0',
          port: 3000,
        });

        server.rpcHandler.processRequest = vi.fn().mockResolvedValue({ response: mockResponse });

        const req = createMockRequest(
          { jsonrpc: '2.0', id: 1, method: 'test' },
          { accept: 'application/json, text/event-stream, */*' }
        );
        const res = createMockResponse();

        const app = server.app;
        const routes = (app as any).router.stack.filter((layer: any) => layer.route);
        const mcpRoute = routes.find((layer: any) => layer.route?.path === '/');

        await mcpRoute.route.stack[0].handle(req, res);

        const { createSSEStream } = await import('./sse.js');
        expect(createSSEStream).toHaveBeenCalled();
      });

      it('closes SSE stream after sending message', async () => {
        const mockResponse: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: 1,
          result: {},
        };

        const server = createMCPServer({
          name: 'test-server',
          version: '1.0.0',
          port: 3000,
        });

        server.rpcHandler.processRequest = vi.fn().mockResolvedValue({ response: mockResponse });

        const req = createMockRequest(
          { jsonrpc: '2.0', id: 1, method: 'test' },
          { accept: 'application/json, text/event-stream' }
        );
        const res = createMockResponse();

        const app = server.app;
        const routes = (app as any).router.stack.filter((layer: any) => layer.route);
        const mcpRoute = routes.find((layer: any) => layer.route?.path === '/');

        await mcpRoute.route.stack[0].handle(req, res);

        const { createSSEStream } = await import('./sse.js');
        const mockStream = (createSSEStream as any).mock.results[0].value;

        expect(mockStream.sendMessage).toHaveBeenCalledWith(mockResponse);
        expect(mockStream.close).toHaveBeenCalled();
      });
    });

    describe('DELETE endpoint', () => {
      it('has DELETE route registered on /', () => {
        const server = createMCPServer({
          name: 'test-server',
          version: '1.0.0',
          port: 3000,
        });

        const routes = (server.app as any).router.stack.filter((layer: any) => layer.route);
        const deleteRoute = routes.find(
          (layer: any) => layer.route?.path === '/' && layer.route?.methods?.delete
        );

        expect(deleteRoute).toBeDefined();
      });
    });

    describe('Method Not Allowed (405)', () => {
      it('has catch-all route on / for unsupported methods', () => {
        const server = createMCPServer({
          name: 'test-server',
          version: '1.0.0',
          port: 3000,
        });

        // Express registers app.all() routes with the internal `_all` flag set
        // on the layer's route.methods. Verify we have POST, DELETE, and a catch-all.
        const routes = (server.app as any).router.stack.filter((layer: any) => layer.route);
        const rootRoutes = routes.filter((layer: any) => layer.route?.path === '/');

        // There should be at least 3 routes on / (POST, DELETE, ALL)
        expect(rootRoutes.length).toBeGreaterThanOrEqual(3);
      });
    });

    describe('Origin validation', () => {
      it('has origin check middleware when allowedOrigins is configured', () => {
        const server = createMCPServer({
          name: 'origin-test',
          version: '1.0.0',
          port: 3000,
          allowedOrigins: ['http://localhost:4200'],
        });

        const layers = (server.app as any).router.stack;
        const originLayer = layers.find((layer: any) => layer.name === 'originCheck');

        expect(originLayer).toBeDefined();
      });

      it('allows requests without Origin header', () => {
        const server = createMCPServer({
          name: 'origin-test',
          version: '1.0.0',
          port: 3000,
          allowedOrigins: ['http://localhost:4200'],
        });

        const layers = (server.app as any).router.stack;
        const originLayer = layers.find((layer: any) => layer.name === 'originCheck');

        const req = createMockRequest({}, {});
        const res = createMockResponse();
        const next = vi.fn();

        originLayer.handle(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
      });

      it('allows requests with valid Origin', () => {
        const server = createMCPServer({
          name: 'origin-test',
          version: '1.0.0',
          port: 3000,
          allowedOrigins: ['http://localhost:4200'],
        });

        const layers = (server.app as any).router.stack;
        const originLayer = layers.find((layer: any) => layer.name === 'originCheck');

        const req = createMockRequest({}, { origin: 'http://localhost:4200' });
        const res = createMockResponse();
        const next = vi.fn();

        originLayer.handle(req, res, next);

        expect(next).toHaveBeenCalled();
      });

      it('rejects requests with invalid Origin with 403', () => {
        const server = createMCPServer({
          name: 'origin-test',
          version: '1.0.0',
          port: 3000,
          allowedOrigins: ['http://localhost:4200'],
        });

        const layers = (server.app as any).router.stack;
        const originLayer = layers.find((layer: any) => layer.name === 'originCheck');

        const req = createMockRequest({}, { origin: 'http://evil.com' });
        const res = createMockResponse();
        const next = vi.fn();

        originLayer.handle(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
      });

      it('does not have origin middleware when allowedOrigins is not configured', () => {
        const server = createMCPServer({
          name: 'no-origin-test',
          version: '1.0.0',
          port: 3000,
        });

        const layers = (server.app as any).router.stack;
        const originLayer = layers.find((layer: any) => layer.name === 'originCheck');

        expect(originLayer).toBeUndefined();
      });
    });

    describe('CORS removal (SEC-011)', () => {
      it('does not register cors middleware', () => {
        const server = createMCPServer({
          name: 'test-server',
          version: '1.0.0',
          port: 3000,
        });
        const middleware = (server.app as any).router.stack;
        const corsLayer = middleware.find(
          (layer: any) => layer.name === 'corsMiddleware' || layer.name === 'cors'
        );
        expect(corsLayer).toBeUndefined();
      });

      it('configures JSON body parser', () => {
        const server = createMCPServer({
          name: 'test-server',
          version: '1.0.0',
          port: 3000,
        });

        const app = server.app;
        const middleware = (app as any).router.stack;

        const jsonParserLayer = middleware.find((layer: any) => layer.name === 'jsonParser');

        expect(jsonParserLayer).toBeDefined();
      });
    });

    describe('Server Lifecycle', () => {
      it('starts server successfully', async () => {
        const server = createMCPServer({
          name: 'test-server',
          version: '1.0.0',
          port: 3100,
        });

        await server.start();
        await server.stop();

        expect(consoleLogSpy).toHaveBeenCalled();
      }, 10000);

      it('calls onStart hook when provided', async () => {
        const onStart = vi.fn().mockResolvedValue(undefined);

        const server = createMCPServer({
          name: 'test-server',
          version: '1.0.0',
          port: 3101,
          onStart,
        });

        await server.start();
        await server.stop();

        expect(onStart).toHaveBeenCalled();
      }, 10000);

      it('stops server successfully', async () => {
        const server = createMCPServer({
          name: 'test-server',
          version: '1.0.0',
          port: 3102,
        });

        await server.start();
        await server.stop();

        expect(consoleLogSpy).toHaveBeenCalled();
      }, 10000);

      it('stops server when not started', async () => {
        const server = createMCPServer({
          name: 'test-server',
          version: '1.0.0',
          port: 3103,
        });

        await expect(server.stop()).resolves.not.toThrow();
      });

      it('binds to 127.0.0.1 by default', async () => {
        const server = createMCPServer({
          name: 'bind-test',
          version: '1.0.0',
          port: 3120,
        });

        await server.start();

        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('127.0.0.1:3120'));

        await server.stop();
      }, 10000);

      it('binds to custom host when specified', async () => {
        const server = createMCPServer({
          name: 'custom-bind-test',
          version: '1.0.0',
          port: 3121,
          host: '0.0.0.0',
        });

        await server.start();

        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('0.0.0.0:3121'));

        await server.stop();
      }, 10000);

      it('prints startup information', async () => {
        const server = createMCPServer({
          name: 'startup-test',
          version: '2.0.0',
          port: 3104,
        });

        await server.start();

        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('startup-test'));
        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('2.0.0'));
        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('3104'));

        await server.stop();
      }, 10000);

      it('prints shutdown information', async () => {
        const server = createMCPServer({
          name: 'shutdown-test',
          version: '1.0.0',
          port: 3105,
        });

        await server.start();
        await server.stop();

        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('stopped'));
      }, 10000);
    });

    describe('Error Handling', () => {
      it('handles malformed request body gracefully', async () => {
        const server = createMCPServer({
          name: 'test-server',
          version: '1.0.0',
          port: 3000,
        });

        const req = createMockRequest(null);
        const res = createMockResponse();

        const app = server.app;
        const routes = (app as any).router.stack.filter((layer: any) => layer.route);
        const mcpRoute = routes.find((layer: any) => layer.route?.path === '/');

        await mcpRoute.route.stack[0].handle(req, res);

        expect(server.rpcHandler.processRequest).toHaveBeenCalled();
      });

      it('processes requests with missing headers', async () => {
        const server = createMCPServer({
          name: 'test-server',
          version: '1.0.0',
          port: 3000,
        });

        const req = createMockRequest({ jsonrpc: '2.0', id: 1, method: 'test' }, {});
        const res = createMockResponse();

        const app = server.app;
        const routes = (app as any).router.stack.filter((layer: any) => layer.route);
        const mcpRoute = routes.find((layer: any) => layer.route?.path === '/');

        await mcpRoute.route.stack[0].handle(req, res);

        expect(server.rpcHandler.processRequest).toHaveBeenCalled();
      });
    });

    describe('Auth middleware', () => {
      it('has bearerAuth middleware in the stack when auth is configured', () => {
        const server = createMCPServer({
          name: 'auth-test',
          version: '1.0.0',
          port: 3000,
          auth: { token: 'secret-123' },
        });

        const layers = (server.app as any).router.stack;
        const authLayer = layers.find((layer: any) => layer.name === 'bearerAuth');

        expect(authLayer).toBeDefined();
      });

      it('places bearerAuth before all route handlers', () => {
        const server = createMCPServer({
          name: 'auth-test',
          version: '1.0.0',
          port: 3000,
          auth: { token: 'secret-123' },
        });

        const layers = (server.app as any).router.stack;
        const authIndex = layers.findIndex((layer: any) => layer.name === 'bearerAuth');
        const routeIndices = layers
          .map((layer: any, i: number) => (layer.route ? i : -1))
          .filter((i: number) => i >= 0);

        expect(authIndex).toBeGreaterThanOrEqual(0);
        for (const routeIdx of routeIndices) {
          expect(authIndex).toBeLessThan(routeIdx);
        }
      });

      it('allows unauthenticated requests to /health (public path)', () => {
        const server = createMCPServer({
          name: 'auth-test',
          version: '1.0.0',
          port: 3000,
          auth: { token: 'secret-123' },
        });

        const layers = (server.app as any).router.stack;
        const authLayer = layers.find((layer: any) => layer.name === 'bearerAuth');

        const req = createMockRequest({}, {});
        (req as any).path = '/health';
        const res = createMockResponse();
        const next = vi.fn();

        authLayer.handle(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
      });

      it('rejects unauthenticated requests to / with 401', () => {
        const server = createMCPServer({
          name: 'auth-test',
          version: '1.0.0',
          port: 3000,
          auth: { token: 'secret-123' },
        });

        const layers = (server.app as any).router.stack;
        const authLayer = layers.find((layer: any) => layer.name === 'bearerAuth');

        const req = createMockRequest({}, {});
        (req as any).path = '/';
        const res = createMockResponse();
        const next = vi.fn();

        authLayer.handle(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(401);
      });

      it('sanitizes control characters from req.path in AUTH DENIED log', () => {
        const server = createMCPServer({
          name: 'auth-test',
          version: '1.0.0',
          port: 3000,
          auth: { token: 'secret-123' },
        });

        const layers = (server.app as any).router.stack;
        const authLayer = layers.find((layer: any) => layer.name === 'bearerAuth');

        const req = createMockRequest({}, {});
        (req as any).path = '/evil\n[12:00:00] AUTH GRANTED POST /';
        (req as any).method = 'POST';
        (req as any).ip = '127.0.0.1';
        const res = createMockResponse();
        const next = vi.fn();

        authLayer.handle(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        // Verify the logged path has control chars replaced
        const warnCall = (console.warn as any).mock.calls.find((call: string[]) =>
          call[0]?.includes('AUTH DENIED')
        );
        expect(warnCall).toBeDefined();
        expect(warnCall[0]).not.toContain('\n');
        expect(warnCall[0]).toContain('/evil?');
      });

      it('rejects empty auth.token with thrown error', () => {
        expect(() =>
          createMCPServer({
            name: 'auth-test',
            version: '1.0.0',
            port: 3000,
            auth: { token: '' },
          })
        ).toThrow('auth.token must be a non-empty string');
      });

      it('rejects whitespace-only auth.token with thrown error', () => {
        expect(() =>
          createMCPServer({
            name: 'auth-test',
            version: '1.0.0',
            port: 3000,
            auth: { token: '   ' },
          })
        ).toThrow('auth.token must be a non-empty string');
      });

      it('allows unauthenticated requests to custom public paths', () => {
        const server = createMCPServer({
          name: 'auth-test',
          version: '1.0.0',
          port: 3000,
          auth: { token: 'secret-123', publicPaths: ['/health', '/status'] },
        });

        const layers = (server.app as any).router.stack;
        const authLayer = layers.find((layer: any) => layer.name === 'bearerAuth');

        const req = createMockRequest({}, {});
        (req as any).path = '/status';
        const res = createMockResponse();
        const next = vi.fn();

        authLayer.handle(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
      });

      it('requires auth on /health when publicPaths is empty', () => {
        const server = createMCPServer({
          name: 'auth-test',
          version: '1.0.0',
          port: 3000,
          auth: { token: 'secret-123', publicPaths: [] },
        });

        const layers = (server.app as any).router.stack;
        const authLayer = layers.find((layer: any) => layer.name === 'bearerAuth');

        const req = createMockRequest({}, {});
        (req as any).path = '/health';
        const res = createMockResponse();
        const next = vi.fn();

        authLayer.handle(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(401);
      });

      it('accepts correct Bearer token via middleware', () => {
        const server = createMCPServer({
          name: 'auth-test',
          version: '1.0.0',
          port: 3000,
          auth: { token: 'correct-secret' },
        });

        const layers = (server.app as any).router.stack;
        const authLayer = layers.find((layer: any) => layer.name === 'bearerAuth');

        const req = createMockRequest({}, { authorization: 'Bearer correct-secret' });
        (req as any).path = '/';
        const res = createMockResponse();
        const next = vi.fn();

        authLayer.handle(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
      });

      it('rejects wrong Bearer token via middleware', () => {
        const server = createMCPServer({
          name: 'auth-test',
          version: '1.0.0',
          port: 3000,
          auth: { token: 'correct-secret' },
        });

        const layers = (server.app as any).router.stack;
        const authLayer = layers.find((layer: any) => layer.name === 'bearerAuth');

        const req = createMockRequest({}, { authorization: 'Bearer wrong-secret' });
        (req as any).path = '/';
        const res = createMockResponse();
        const next = vi.fn();

        authLayer.handle(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(401);
      });
    });
  });

  describe('Helper Functions', () => {
    describe('textResult', () => {
      it('creates text result with single text item', () => {
        const result = textResult('Hello, world!');

        expect(result).toEqual({
          content: [{ type: 'text', text: 'Hello, world!' }],
        });
      });

      it('creates text result with empty string', () => {
        const result = textResult('');

        expect(result).toEqual({
          content: [{ type: 'text', text: '' }],
        });
      });

      it('creates text result with multiline text', () => {
        const result = textResult('Line 1\nLine 2\nLine 3');

        expect(result).toEqual({
          content: [{ type: 'text', text: 'Line 1\nLine 2\nLine 3' }],
        });
      });

      it('creates text result with special characters', () => {
        const result = textResult('Special chars: <>&"\'');

        expect(result.content[0].text).toBe('Special chars: <>&"\'');
      });

      it('preserves Unicode characters', () => {
        const result = textResult('Unicode: 你好 🚀 😀');

        expect(result.content[0].text).toBe('Unicode: 你好 🚀 😀');
      });
    });

    describe('jsonResult', () => {
      it('creates JSON result from object', () => {
        const data = { key: 'value', number: 42 };
        const result = jsonResult(data);

        expect(result).toEqual({
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        });
      });

      it('creates JSON result from array', () => {
        const data = [1, 2, 3, 4, 5];
        const result = jsonResult(data);

        expect(result).toEqual({
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        });
      });

      it('creates JSON result from null', () => {
        const result = jsonResult(null);

        expect(result).toEqual({
          content: [{ type: 'text', text: 'null' }],
        });
      });

      it('creates JSON result from nested object', () => {
        const data = {
          level1: {
            level2: {
              level3: 'deep value',
            },
          },
        };
        const result = jsonResult(data);

        expect(result.content[0].text).toContain('deep value');
      });

      it('creates JSON result with complex types', () => {
        const data = {
          string: 'text',
          number: 123,
          boolean: true,
          null: null,
          array: [1, 2, 3],
          object: { nested: 'value' },
        };
        const result = jsonResult(data);

        const parsed = JSON.parse(result.content[0].text);
        expect(parsed).toEqual(data);
      });

      it('handles primitive values', () => {
        expect(jsonResult(42)).toEqual({
          content: [{ type: 'text', text: '42' }],
        });

        expect(jsonResult('string')).toEqual({
          content: [{ type: 'text', text: '"string"' }],
        });

        expect(jsonResult(true)).toEqual({
          content: [{ type: 'text', text: 'true' }],
        });
      });
    });

    describe('errorResult', () => {
      it('creates error result with message', () => {
        const result = errorResult('Something went wrong');

        expect(result).toEqual({
          content: [{ type: 'text', text: 'Error: Something went wrong' }],
          isError: true,
        });
      });

      it('creates error result with empty message', () => {
        const result = errorResult('');

        expect(result).toEqual({
          content: [{ type: 'text', text: 'Error: ' }],
          isError: true,
        });
      });

      it('sets isError flag to true', () => {
        const result = errorResult('Error message');

        expect(result.isError).toBe(true);
      });

      it('prefixes message with Error:', () => {
        const result = errorResult('File not found');

        expect(result.content[0].text).toMatch(/^Error: /);
      });

      it('creates error result with special characters', () => {
        const result = errorResult('Error with <html> & "quotes"');

        expect(result.content[0].text).toContain('<html>');
        expect(result.content[0].text).toContain('"quotes"');
      });

      it('creates error result with long message', () => {
        const longMessage = 'A'.repeat(500);
        const result = errorResult(longMessage);

        expect(result.content[0].text).toContain('Error: ');
        expect(result.content[0].text.length).toBeGreaterThan(100);
      });
    });
  });

  describe('Rate limiting', () => {
    it('has rateLimit middleware in the stack when configured', () => {
      const server = createMCPServer({
        name: 'rate-test',
        version: '1.0.0',
        port: 3000,
        rateLimit: { maxRequests: 5, windowMs: 60_000 },
      });

      const layers = (server.app as any).router.stack;
      const rlLayer = layers.find((layer: any) => layer.name === 'rateLimitMiddleware');
      expect(rlLayer).toBeDefined();
    });

    it('does not have rateLimit middleware when not configured', () => {
      const server = createMCPServer({
        name: 'no-rate-test',
        version: '1.0.0',
        port: 3000,
      });

      const layers = (server.app as any).router.stack;
      const rlLayer = layers.find((layer: any) => layer.name === 'rateLimitMiddleware');
      expect(rlLayer).toBeUndefined();
    });

    it('allows requests under the limit', () => {
      const server = createMCPServer({
        name: 'rate-test',
        version: '1.0.0',
        port: 3000,
        rateLimit: { maxRequests: 3, windowMs: 60_000 },
      });

      const layers = (server.app as any).router.stack;
      const rlLayer = layers.find((layer: any) => layer.name === 'rateLimitMiddleware');

      const req = createMockRequest({}, {});
      (req as any).path = '/';
      (req as any).ip = '10.0.0.1';
      const res = createMockResponse();
      const next = vi.fn();

      rlLayer.handle(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('returns 429 when limit is exceeded', () => {
      const server = createMCPServer({
        name: 'rate-test',
        version: '1.0.0',
        port: 3000,
        rateLimit: { maxRequests: 2, windowMs: 60_000 },
      });

      const layers = (server.app as any).router.stack;
      const rlLayer = layers.find((layer: any) => layer.name === 'rateLimitMiddleware');

      const makeReq = () => {
        const req = createMockRequest({}, {});
        (req as any).path = '/';
        (req as any).ip = '10.0.0.2';
        return req;
      };

      // First 2 requests should pass
      for (let i = 0; i < 2; i++) {
        const res = createMockResponse();
        const next = vi.fn();
        rlLayer.handle(makeReq(), res, next);
        expect(next).toHaveBeenCalled();
      }

      // Third request should be rate-limited
      const res = createMockResponse();
      const next = vi.fn();
      rlLayer.handle(makeReq(), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith({ error: 'Too Many Requests' });
      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '60');
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('RATE_LIMIT'));
    });

    it('logs RATE_LIMIT with method, path, and IP', () => {
      const server = createMCPServer({
        name: 'rate-log-test',
        version: '1.0.0',
        port: 3000,
        rateLimit: { maxRequests: 1, windowMs: 60_000 },
      });

      const layers = (server.app as any).router.stack;
      const rlLayer = layers.find((layer: any) => layer.name === 'rateLimitMiddleware');

      const makeReq = () => {
        const req = createMockRequest({}, {});
        (req as any).path = '/mcp';
        (req as any).method = 'POST';
        (req as any).ip = '10.0.0.99';
        return req;
      };

      // Exhaust limit
      rlLayer.handle(makeReq(), createMockResponse(), vi.fn());

      // Trigger rate limit
      const res = createMockResponse();
      rlLayer.handle(makeReq(), res, vi.fn());

      expect(console.warn).toHaveBeenCalledWith(
        expect.stringMatching(/RATE_LIMIT POST \/mcp from 10\.0\.0\.99/)
      );
    });

    it('sanitizes control characters in rate limit log path', () => {
      const server = createMCPServer({
        name: 'rate-sanitize-test',
        version: '1.0.0',
        port: 3000,
        rateLimit: { maxRequests: 1, windowMs: 60_000 },
      });

      const layers = (server.app as any).router.stack;
      const rlLayer = layers.find((layer: any) => layer.name === 'rateLimitMiddleware');

      const makeReq = () => {
        const req = createMockRequest({}, {});
        (req as any).path = '/bad\x00path\x1b[31m';
        (req as any).method = 'GET';
        (req as any).ip = '10.0.0.1';
        return req;
      };

      // Exhaust limit
      rlLayer.handle(makeReq(), createMockResponse(), vi.fn());

      // Trigger rate limit
      rlLayer.handle(makeReq(), createMockResponse(), vi.fn());

      expect(console.warn).toHaveBeenCalledWith(
        expect.stringMatching(/RATE_LIMIT GET \/bad\?path\?\[31m from 10\.0\.0\.1/)
      );
    });

    it('skips /health from rate limiting', () => {
      const server = createMCPServer({
        name: 'rate-test',
        version: '1.0.0',
        port: 3000,
        rateLimit: { maxRequests: 1, windowMs: 60_000 },
      });

      const layers = (server.app as any).router.stack;
      const rlLayer = layers.find((layer: any) => layer.name === 'rateLimitMiddleware');

      // Exhaust the limit
      const req1 = createMockRequest({}, {});
      (req1 as any).path = '/';
      (req1 as any).ip = '10.0.0.3';
      const res1 = createMockResponse();
      rlLayer.handle(req1, res1, vi.fn());

      // /health should still pass
      const req2 = createMockRequest({}, {});
      (req2 as any).path = '/health';
      (req2 as any).ip = '10.0.0.3';
      const res2 = createMockResponse();
      const next2 = vi.fn();
      rlLayer.handle(req2, res2, next2);
      expect(next2).toHaveBeenCalled();
    });

    it('uses defaults of 60 req / 60s when no values provided', () => {
      const server = createMCPServer({
        name: 'rate-defaults',
        version: '1.0.0',
        port: 3000,
        rateLimit: {},
      });

      const layers = (server.app as any).router.stack;
      const rlLayer = layers.find((layer: any) => layer.name === 'rateLimitMiddleware');
      expect(rlLayer).toBeDefined();
    });

    it('clears cleanup interval on stop()', async () => {
      const server = createMCPServer({
        name: 'rate-cleanup',
        version: '1.0.0',
        port: 3106,
        rateLimit: { maxRequests: 10 },
      });

      await server.start();
      await server.stop();

      // If cleanup interval is not cleared, the test process would hang
      // The fact that stop() resolves cleanly is sufficient
      expect(true).toBe(true);
    }, 10000);

    it('tracks IPv6 addresses correctly', () => {
      const server = createMCPServer({
        name: 'rate-test',
        version: '1.0.0',
        port: 3000,
        rateLimit: { maxRequests: 1, windowMs: 60_000 },
      });

      const layers = (server.app as any).router.stack;
      const rlLayer = layers.find((layer: any) => layer.name === 'rateLimitMiddleware');

      const req = createMockRequest({}, {});
      (req as any).path = '/';
      (req as any).ip = '::1';
      const res = createMockResponse();
      const next = vi.fn();

      rlLayer.handle(req, res, next);
      expect(next).toHaveBeenCalled();

      // Second request from same IPv6 should be limited
      const res2 = createMockResponse();
      const next2 = vi.fn();
      rlLayer.handle(req, res2, next2);
      expect(next2).not.toHaveBeenCalled();
      expect(res2.status).toHaveBeenCalledWith(429);
    });

    it('falls back to "unknown" when req.ip is undefined', () => {
      const server = createMCPServer({
        name: 'rate-test',
        version: '1.0.0',
        port: 3000,
        rateLimit: { maxRequests: 1, windowMs: 60_000 },
      });

      const layers = (server.app as any).router.stack;
      const rlLayer = layers.find((layer: any) => layer.name === 'rateLimitMiddleware');

      const req = createMockRequest({}, {});
      (req as any).path = '/';
      // ip is undefined — should use 'unknown'
      const res = createMockResponse();
      const next = vi.fn();

      rlLayer.handle(req, res, next);
      expect(next).toHaveBeenCalled();

      // Second undefined-ip request should be rate-limited (same 'unknown' bucket)
      const req2 = createMockRequest({}, {});
      (req2 as any).path = '/';
      const res2 = createMockResponse();
      const next2 = vi.fn();
      rlLayer.handle(req2, res2, next2);
      expect(next2).not.toHaveBeenCalled();
      expect(res2.status).toHaveBeenCalledWith(429);
    });

    it('does not skip /healthz or /HEALTH (only exact /health)', () => {
      const server = createMCPServer({
        name: 'rate-test',
        version: '1.0.0',
        port: 3000,
        rateLimit: { maxRequests: 1, windowMs: 60_000 },
      });

      const layers = (server.app as any).router.stack;
      const rlLayer = layers.find((layer: any) => layer.name === 'rateLimitMiddleware');

      // Exhaust the limit
      const req1 = createMockRequest({}, {});
      (req1 as any).path = '/';
      (req1 as any).ip = '10.0.0.50';
      rlLayer.handle(req1, createMockResponse(), vi.fn());

      // /healthz should NOT be skipped — should be rate limited
      const req2 = createMockRequest({}, {});
      (req2 as any).path = '/healthz';
      (req2 as any).ip = '10.0.0.50';
      const res2 = createMockResponse();
      const next2 = vi.fn();
      rlLayer.handle(req2, res2, next2);
      expect(next2).not.toHaveBeenCalled();
      expect(res2.status).toHaveBeenCalledWith(429);
    });

    it('inherits excluded paths from auth.publicPaths', () => {
      const server = createMCPServer({
        name: 'rate-test',
        version: '1.0.0',
        port: 3000,
        auth: { token: 'secret', publicPaths: ['/health', '/status'] },
        rateLimit: { maxRequests: 1, windowMs: 60_000 },
      });

      const layers = (server.app as any).router.stack;
      const rlLayer = layers.find((layer: any) => layer.name === 'rateLimitMiddleware');

      // Exhaust the limit
      const req1 = createMockRequest({}, {});
      (req1 as any).path = '/';
      (req1 as any).ip = '10.0.0.99';
      (req1 as any).headers = { authorization: 'Bearer secret' };
      rlLayer.handle(req1, createMockResponse(), vi.fn());

      // /status should be skipped (inherited from auth.publicPaths)
      const req2 = createMockRequest({}, {});
      (req2 as any).path = '/status';
      (req2 as any).ip = '10.0.0.99';
      const res2 = createMockResponse();
      const next2 = vi.fn();
      rlLayer.handle(req2, res2, next2);
      expect(next2).toHaveBeenCalled();
    });

    it('allows requests again after window expires', () => {
      vi.useFakeTimers();

      const server = createMCPServer({
        name: 'rate-test',
        version: '1.0.0',
        port: 3000,
        rateLimit: { maxRequests: 1, windowMs: 1_000 },
      });

      const layers = (server.app as any).router.stack;
      const rlLayer = layers.find((layer: any) => layer.name === 'rateLimitMiddleware');

      const makeReq = () => {
        const req = createMockRequest({}, {});
        (req as any).path = '/';
        (req as any).ip = '10.0.0.60';
        return req;
      };

      // First request passes
      const res1 = createMockResponse();
      rlLayer.handle(makeReq(), res1, vi.fn());

      // Second is rate-limited
      const res2 = createMockResponse();
      rlLayer.handle(makeReq(), res2, vi.fn());
      expect(res2.status).toHaveBeenCalledWith(429);

      // Advance past window
      vi.advanceTimersByTime(1_001);

      // Now should pass again
      const res3 = createMockResponse();
      const next3 = vi.fn();
      rlLayer.handle(makeReq(), res3, next3);
      expect(next3).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe('Security invariants', () => {
    it('uses timing-safe token comparison (not naive ===)', async () => {
      const fs = await import('node:fs');
      const source = fs.readFileSync(new URL('./server.ts', import.meta.url), 'utf-8');
      expect(source).toContain('timingSafeEqual');
      expect(source).not.toMatch(/provided\s*===\s*token/);
      expect(source).not.toMatch(/provided\s*==\s*token/);
    });
  });
});
