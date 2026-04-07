/**
 * JSON-RPC 2.0 Message Handler for MCP
 * Provides a generic handler that can be configured with tools
 */

import type {
  JSONRPCRequest,
  JSONRPCResponse,
  JSONRPCError,
  InitializeResult,
  ToolsListResult,
  Tool,
  ToolHandler,
  ProcessRequestResult,
} from './types.js';
import { JSONRPCErrorCode, SUPPORTED_PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION } from './types.js';
import { validateJSONRPCMessage, validateToolName } from './security.js';
import { sessionManager } from './session.js';
import { ts } from './logger.js';

/** Page size for tools/list pagination */
const TOOLS_LIST_PAGE_SIZE = 100;

/**
 * JSON-RPC Error Builder
 * Creates standardized error objects
 */
export class JSONRPCErrorBuilder {
  /**
   * Creates a parse error (code -32700) for malformed JSON
   * @param message - Optional custom error message
   * @returns JSON-RPC error object
   */
  static parseError(message: string = 'Parse error'): JSONRPCError {
    return { code: JSONRPCErrorCode.ParseError, message };
  }

  /**
   * Creates an invalid request error (code -32600) for malformed requests
   * @param message - Optional custom error message
   * @returns JSON-RPC error object
   */
  static invalidRequest(message: string = 'Invalid Request'): JSONRPCError {
    return { code: JSONRPCErrorCode.InvalidRequest, message };
  }

  /**
   * Creates a method not found error (code -32601) when method doesn't exist
   * @param method - Name of the method that was not found
   * @returns JSON-RPC error object
   */
  static methodNotFound(method: string): JSONRPCError {
    return { code: JSONRPCErrorCode.MethodNotFound, message: `Method not found: ${method}` };
  }

  /**
   * Creates an invalid params error (code -32602) for incorrect parameters
   * @param message - Optional custom error message
   * @returns JSON-RPC error object
   */
  static invalidParams(message: string = 'Invalid params'): JSONRPCError {
    return { code: JSONRPCErrorCode.InvalidParams, message };
  }

  /**
   * Creates an internal error (code -32603) with error details
   * @param error - The original error object
   * @returns JSON-RPC error object
   */
  static internalError(error: unknown): JSONRPCError {
    console.error(`[JSONRPCErrorBuilder] Internal error details:`, error);
    return { code: JSONRPCErrorCode.InternalError, message: 'Internal error' };
  }

  /**
   * Creates a session error (code -32001) for invalid or expired sessions
   * @param message - Optional custom error message
   * @returns JSON-RPC error object
   */
  static sessionError(message: string = 'Invalid or expired session'): JSONRPCError {
    return { code: JSONRPCErrorCode.SessionError, message };
  }
}

/**
 * Configuration options for creating a JSON-RPC handler instance.
 * Used to identify the server in initialization responses.
 */
export interface JSONRPCHandlerOptions {
  /** Server name */
  name: string;
  /** Server version */
  version: string;
  /** Optional human-readable instructions for the client (included in initialize result) */
  instructions?: string;
}

/**
 * JSON-RPC Handler
 * Processes MCP protocol messages
 */
export class JSONRPCHandler {
  private tools: Map<string, Tool> = new Map();
  private toolHandlers: Map<string, ToolHandler> = new Map();
  private serverInfo: { name: string; version: string };
  private instructions?: string;

  /**
   * Creates a new JSON-RPC handler instance with server identification
   * @param options - Configuration including server name and version
   */
  constructor(options: JSONRPCHandlerOptions) {
    this.serverInfo = { name: options.name, version: options.version };
    this.instructions = options.instructions;
  }

  /**
   * Register a tool with its handler
   * @param tool Tool definition
   * @param handler Tool handler function
   */
  public registerTool(tool: Tool, handler: ToolHandler): void {
    if (!validateToolName(tool.name)) {
      throw new Error(`Invalid tool name: ${tool.name}`);
    }

    this.tools.set(tool.name, tool);
    this.toolHandlers.set(tool.name, handler);
    console.log(`${ts()} 🔧 Tool registered: ${tool.name}`);
  }

  /**
   * Process a JSON-RPC request or notification
   * @param body Request body
   * @param sessionId Session ID (or null for new session)
   * @returns ProcessRequestResult with response (null for notifications) and optional sessionId
   */
  public async processRequest(
    body: unknown,
    sessionId: string | null
  ): Promise<ProcessRequestResult> {
    // Check for notification before full validation (notifications have no id)
    const message = body as Record<string, unknown>;
    if (
      typeof message === 'object' &&
      message !== null &&
      typeof message.method === 'string' &&
      !('id' in message)
    ) {
      return this.handleNotification(message.method, message.params as Record<string, unknown>);
    }

    if (!validateJSONRPCMessage(body)) {
      return { response: this.buildErrorResponse(null, JSONRPCErrorBuilder.invalidRequest()) };
    }

    const request = body as JSONRPCRequest;

    try {
      switch (request.method) {
        case 'initialize':
          return await this.handleInitialize(request);

        case 'ping':
          return { response: { jsonrpc: '2.0', id: request.id, result: {} } };

        case 'logging/setLevel':
          return { response: { jsonrpc: '2.0', id: request.id, result: {} } };

        case 'tools/list':
          return { response: await this.handleToolsList(request, sessionId) };

        case 'tools/call':
          return { response: await this.handleToolsCall(request, sessionId) };

        default:
          return {
            response: this.buildErrorResponse(
              request.id,
              JSONRPCErrorBuilder.methodNotFound(request.method)
            ),
          };
      }
    } catch (error) {
      return {
        response: this.buildErrorResponse(request.id, JSONRPCErrorBuilder.internalError(error)),
      };
    }
  }

  /**
   * Handle JSON-RPC notifications (messages without id).
   * Per JSON-RPC spec, notifications produce no response.
   * @param method - Notification method name
   * @param params - Optional notification parameters
   */
  private handleNotification(
    method: string,
    params?: Record<string, unknown>
  ): ProcessRequestResult {
    switch (method) {
      case 'notifications/initialized':
        console.log(`${ts()} Client initialized`);
        return { response: null };

      case 'notifications/cancelled': {
        const requestId = params?.requestId ?? 'unknown';
        console.log(`${ts()} Client cancelled request: ${requestId}`);
        return { response: null };
      }

      default:
        if (method.startsWith('notifications/')) {
          console.warn(`${ts()} Unknown notification: ${method}`);
        } else {
          console.warn(`${ts()} Ignoring notification for non-notification method: ${method}`);
        }
        return { response: null };
    }
  }

  /**
   * Handle initialize request
   * @param request - The initialization request from the client
   * @returns ProcessRequestResult with server capabilities and sessionId
   */
  private async handleInitialize(request: JSONRPCRequest): Promise<ProcessRequestResult> {
    const params = request.params;

    if (!params || typeof params !== 'object') {
      return {
        response: this.buildErrorResponse(
          request.id,
          JSONRPCErrorBuilder.invalidParams('initialize requires params object')
        ),
      };
    }

    if (typeof params.protocolVersion !== 'string') {
      return {
        response: this.buildErrorResponse(
          request.id,
          JSONRPCErrorBuilder.invalidParams('initialize requires params.protocolVersion as string')
        ),
      };
    }

    const clientInfo = params.clientInfo as Record<string, unknown> | undefined;
    if (
      !clientInfo ||
      typeof clientInfo !== 'object' ||
      typeof clientInfo.name !== 'string' ||
      typeof clientInfo.version !== 'string'
    ) {
      return {
        response: this.buildErrorResponse(
          request.id,
          JSONRPCErrorBuilder.invalidParams(
            'initialize requires params.clientInfo with name and version as strings'
          )
        ),
      };
    }

    const negotiated = SUPPORTED_PROTOCOL_VERSIONS.includes(params.protocolVersion)
      ? params.protocolVersion
      : LATEST_PROTOCOL_VERSION;

    const validatedClientInfo = {
      name: clientInfo.name as string,
      version: clientInfo.version as string,
    };
    const newSessionId = sessionManager.createSession(validatedClientInfo);

    console.log(
      `${ts()} Initialize from ${validatedClientInfo.name} v${validatedClientInfo.version}`
    );

    const result: InitializeResult = {
      protocolVersion: negotiated,
      capabilities: {
        logging: {},
        tools: { listChanged: false },
      },
      serverInfo: this.serverInfo,
    };

    const responseResult: Record<string, unknown> = { ...result };
    if (this.instructions) {
      responseResult.instructions = this.instructions;
    }

    return {
      response: {
        jsonrpc: '2.0',
        id: request.id,
        result: responseResult,
      },
      sessionId: newSessionId,
    };
  }

  /**
   * Handle tools/list request
   * @param request - The tools list request from the client
   * @param sessionId - Current session ID or null for new session
   * @returns JSON-RPC response with list of available tools
   */
  private async handleToolsList(
    request: JSONRPCRequest,
    sessionId: string | null
  ): Promise<JSONRPCResponse> {
    if (!sessionId || !sessionManager.getSession(sessionId)) {
      sessionManager.createSession({ name: 'auto-reconnect', version: '1.0' });
    }

    const allTools = Array.from(this.tools.values());
    const cursor = request.params?.cursor as string | undefined;
    let startIndex = 0;
    if (cursor) {
      const parsed = parseInt(Buffer.from(cursor, 'base64').toString(), 10);
      if (Number.isNaN(parsed) || parsed < 0) {
        return this.buildErrorResponse(
          request.id,
          JSONRPCErrorBuilder.invalidParams('Invalid cursor: must encode a non-negative integer')
        );
      }
      startIndex = parsed;
    }
    const page = allTools.slice(startIndex, startIndex + TOOLS_LIST_PAGE_SIZE);
    const nextCursor =
      startIndex + TOOLS_LIST_PAGE_SIZE < allTools.length
        ? Buffer.from(String(startIndex + TOOLS_LIST_PAGE_SIZE)).toString('base64')
        : undefined;

    const result: ToolsListResult = {
      tools: page,
      ...(nextCursor && { nextCursor }),
    };

    return { jsonrpc: '2.0', id: request.id, result };
  }

  /**
   * Handle tools/call request
   * @param request - The tool execution request from the client
   * @param sessionId - Current session ID or null for new session
   * @returns JSON-RPC response with tool execution result
   */
  private async handleToolsCall(
    request: JSONRPCRequest,
    sessionId: string | null
  ): Promise<JSONRPCResponse> {
    if (!sessionId || !sessionManager.getSession(sessionId)) {
      sessionManager.createSession({ name: 'auto-reconnect', version: '1.0' });
    }

    const params = request.params;
    if (!params || typeof params !== 'object') {
      return this.buildErrorResponse(
        request.id,
        JSONRPCErrorBuilder.invalidParams('tools/call requires params object')
      );
    }

    if (typeof params.name !== 'string') {
      return this.buildErrorResponse(
        request.id,
        JSONRPCErrorBuilder.invalidParams('tools/call requires params.name as string')
      );
    }

    const name = params.name;
    const rawArgs = params.arguments;
    const args: Record<string, unknown> =
      rawArgs !== null &&
      rawArgs !== undefined &&
      typeof rawArgs === 'object' &&
      !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};

    if (!validateToolName(name)) {
      return this.buildErrorResponse(
        request.id,
        JSONRPCErrorBuilder.invalidParams(`Invalid tool name: ${name}`)
      );
    }

    const handler = this.toolHandlers.get(name);
    if (!handler) {
      const registeredTools = Array.from(this.toolHandlers.keys());
      console.error(
        `${ts()} ❌ Tool not found: "${name}". Registered tools (${registeredTools.length}): ${registeredTools.slice(0, 10).join(', ')}${registeredTools.length > 10 ? '...' : ''}`
      );
      return this.buildErrorResponse(
        request.id,
        JSONRPCErrorBuilder.methodNotFound(`Tool not found: ${name}`)
      );
    }

    try {
      console.log(`${ts()} 🔧 Executing tool: ${name}`);
      const result = await handler(args);
      return { jsonrpc: '2.0', id: request.id, result };
    } catch (error) {
      return this.buildErrorResponse(request.id, JSONRPCErrorBuilder.internalError(error));
    }
  }

  /**
   * Build an error response
   * @param id - Request ID to correlate the error with
   * @param error - The JSON-RPC error object to return
   * @returns JSON-RPC error response
   */
  private buildErrorResponse(id: string | number | null, error: JSONRPCError): JSONRPCResponse {
    return { jsonrpc: '2.0', id: id ?? null, error };
  }

  /**
   * Get registered tools
   */
  public getTools(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get server info
   */
  public getServerInfo(): { name: string; version: string } {
    return this.serverInfo;
  }
}
