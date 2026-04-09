/**
 * MCP Server Factory
 * Creates Express-based MCP servers with minimal boilerplate
 *
 * Usage:
 * ```typescript
 * import { createMCPServer } from '@speedwave/mcp-shared';
 *
 * const server = createMCPServer({
 *   name: 'slack',
 *   version: '0.55.0',
 *   port: 3001,
 *   tools: [
 *     { tool: getChannelsTool, handler: getChannelsHandler },
 *     { tool: readChannelTool, handler: readChannelHandler },
 *   ],
 * });
 *
 * server.start();
 * ```
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Tool, ToolHandler, ToolDefinition } from './types.js';
import { JSONRPCHandler } from './jsonrpc.js';
import { validateOrigin } from './security.js';
import { handleMCPPost, handleMCPDelete } from './transport.js';
import { ts } from './logger.js';

//═══════════════════════════════════════════════════════════════════════════════
// Configuration Types
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Bearer token authentication configuration.
 * When set, all requests except publicPaths require a valid Authorization header.
 */
export interface MCPServerAuth {
  /** The Bearer token value (already resolved, NOT an env var name) */
  token: string;
  /** Paths excluded from auth (default: ['/health']) */
  publicPaths?: string[];
}

/**
 * Configuration options for creating an MCP server instance.
 * Defines server identity, network settings, and optional handlers.
 *
 * Note: MCP workers run inside an isolated Docker network without host-exposed
 * ports (SEC-011). The cors middleware has been removed.
 */
export interface MCPServerOptions {
  /** Server name (shown to clients) */
  name: string;
  /** Server version */
  version: string;
  /** Port to listen on */
  port: number;
  /** Host/IP to bind to (default: '127.0.0.1'). Use '0.0.0.0' only inside containers. */
  host?: string;
  /** Tools to register */
  tools?: ToolDefinition[];
  /** Custom health check — runs as a connectivity probe; return value is discarded to prevent metadata leakage */
  healthCheck?: () => Promise<void>;
  /** Bearer token auth — when set, all requests except publicPaths require Authorization header */
  auth?: MCPServerAuth;
  /**
   * Allowed Origin values for CORS-like validation. When set, requests with an
   * Origin header not in the list are rejected with 403. Requests without an
   * Origin header (non-browser clients) are always allowed.
   */
  allowedOrigins?: string[];
  /** Rate limiting — sliding window per IP. Disabled when not set. */
  rateLimit?: {
    maxRequests?: number;
    windowMs?: number;
    /**
     * Paths to exclude from rate limiting.
     * When provided, replaces (does not merge with) auth.publicPaths and the default ['/health'].
     * Include '/health' explicitly if you need it excluded.
     */
    excludedPaths?: string[];
  };
  /** Called when server starts */
  onStart?: () => Promise<void>;
}

/**
 * MCP server instance with methods for lifecycle management.
 * Provides access to Express app and tool registration.
 */
export interface MCPServer {
  /** Express app instance. Prefer using auth option over direct app.use() — middleware added via app.use() after creation runs AFTER built-in route handlers. */
  app: Express;
  /** JSON-RPC handler */
  rpcHandler: JSONRPCHandler;
  /** Register a tool */
  registerTool: (tool: Tool, handler: ToolHandler) => void;
  /** Start the server. Returns the actual port (useful when configured port is 0). */
  start: () => Promise<number>;
  /** Stop the server */
  stop: () => Promise<void>;
}

//═══════════════════════════════════════════════════════════════════════════════
// Server Factory
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Create an MCP server with Streamable HTTP transport
 *
 * Features:
 * - Express-based HTTP server
 * - JSON-RPC 2.0 protocol
 * - Optional SSE streaming
 * - Rate limiting
 * - Session management
 * - Health check endpoint
 *
 * Note: Security provided by Docker network isolation (no exposed ports)
 * @param options Server configuration
 * @returns MCP server instance
 */
export function createMCPServer(options: MCPServerOptions): MCPServer {
  const { name, version, port, host = '127.0.0.1', tools = [] } = options;

  const app = express();
  app.disable('x-powered-by');
  const rpcHandler = new JSONRPCHandler({ name, version });

  // Server state
  let server: ReturnType<Express['listen']> | null = null;
  let rateLimitCleanupInterval: ReturnType<typeof setInterval> | null = null;

  //─────────────────────────────────────────────────────────────────────────────
  // Middleware
  //─────────────────────────────────────────────────────────────────────────────

  app.use(express.json({ limit: '1mb' }));

  // Bearer token auth middleware — registered before route handlers
  if (options.auth) {
    if (!options.auth.token || !options.auth.token.trim()) {
      throw new Error(`${name}: auth.token must be a non-empty string`);
    }
    const { token, publicPaths = ['/health'] } = options.auth;

    /**
     * Named for test discoverability (shows as 'bearerAuth' in Express router stack).
     * @param req - Express request
     * @param res - Express response
     * @param next - Express next function
     */
    function bearerAuth(req: Request, res: Response, next: NextFunction): void {
      if (publicPaths.includes(req.path)) {
        next();
        return;
      }

      const header = req.headers.authorization ?? '';
      const provided = header.startsWith('Bearer ') ? header.slice(7) : '';

      if (!provided || !safeTokenCompare(provided, token)) {
        // eslint-disable-next-line no-control-regex -- intentional: strip C0/DEL control chars to prevent log injection
        const safePath = req.path.replace(/[\x00-\x1f\x7f]/g, '?');
        console.warn(`${ts()} AUTH DENIED ${req.method} ${safePath} from ${req.ip ?? 'unknown'}`);
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      next();
    }

    app.use(bearerAuth);
  }

  //─────────────────────────────────────────────────────────────────────────────
  // Rate Limiting Middleware
  //─────────────────────────────────────────────────────────────────────────────

  if (options.rateLimit) {
    const maxRequests = options.rateLimit.maxRequests ?? 60;
    const windowMs = options.rateLimit.windowMs ?? 60_000;
    const rateLimitExcluded = options.rateLimit.excludedPaths ??
      options.auth?.publicPaths ?? ['/health'];
    const hits = new Map<string, number[]>();

    // Periodic cleanup every 5 minutes to prevent memory leak from stale IPs
    const CLEANUP_INTERVAL_MS = 5 * 60_000;
    rateLimitCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [ip, timestamps] of hits) {
        const valid = timestamps.filter((t) => now - t < windowMs);
        if (valid.length === 0) {
          hits.delete(ip);
        } else {
          hits.set(ip, valid);
        }
      }
    }, CLEANUP_INTERVAL_MS);
    rateLimitCleanupInterval.unref();

    // Note: in Speedwave's architecture, all mcp-hub traffic to mcp-os arrives
    // from the same container network IP, so this is effectively a global bucket
    // rather than per-client rate limiting. This is acceptable for the threat model.
    function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
      if (rateLimitExcluded.includes(req.path)) {
        next();
        return;
      }

      const ip = req.ip ?? 'unknown';
      const now = Date.now();
      const timestamps = hits.get(ip) ?? [];
      const valid = timestamps.filter((t) => now - t < windowMs);

      if (valid.length >= maxRequests) {
        // eslint-disable-next-line no-control-regex -- intentional: strip C0/DEL control chars to prevent log injection
        const safePath = req.path.replace(/[\x00-\x1f\x7f]/g, '?');
        console.warn(`${ts()} RATE_LIMIT ${req.method} ${safePath} from ${ip}`);
        res.setHeader('Retry-After', Math.ceil(windowMs / 1000).toString());
        res.status(429).json({ error: 'Too Many Requests' });
        return;
      }

      valid.push(now);
      hits.set(ip, valid);
      next();
    }

    app.use(rateLimitMiddleware);
  }

  //─────────────────────────────────────────────────────────────────────────────
  // Health Check Endpoint
  //─────────────────────────────────────────────────────────────────────────────

  app.get('/health', async (_req: Request, res: Response) => {
    if (options.healthCheck) {
      try {
        await options.healthCheck();
      } catch (error) {
        if (!options.auth) {
          console.error(`[${name}] Health check failed:`, error);
        }
        res.status(500).json({ status: 'error' });
        return;
      }
    }
    res.json({ status: 'ok' });
  });

  //─────────────────────────────────────────────────────────────────────────────
  // Origin Validation Middleware (when allowedOrigins is configured)
  //─────────────────────────────────────────────────────────────────────────────

  if (options.allowedOrigins) {
    const origins = options.allowedOrigins;

    function originCheck(req: Request, res: Response, next: NextFunction): void {
      const origin = req.get('origin');
      if (!validateOrigin(origin, origins)) {
        res.status(403).json({ error: 'Forbidden: origin not allowed' });
        return;
      }
      next();
    }

    app.use(originCheck);
  }

  //─────────────────────────────────────────────────────────────────────────────
  // MCP Protocol Endpoints (Streamable HTTP)
  //─────────────────────────────────────────────────────────────────────────────

  app.post('/', async (req: Request, res: Response) => {
    await handleMCPPost(rpcHandler, req, res);
  });

  app.delete('/', (req: Request, res: Response) => {
    handleMCPDelete(req, res);
  });

  //─────────────────────────────────────────────────────────────────────────────
  // Method Not Allowed Handler (405 for unsupported HTTP methods on /)
  //─────────────────────────────────────────────────────────────────────────────

  app.all('/', (_req: Request, res: Response) => {
    res.setHeader('Allow', 'POST, DELETE');
    res.status(405).json({ error: 'Method Not Allowed' });
  });

  //─────────────────────────────────────────────────────────────────────────────
  // Tool Registration
  //─────────────────────────────────────────────────────────────────────────────

  function registerTool(tool: Tool, handler: ToolHandler): void {
    rpcHandler.registerTool(tool, handler);
  }

  // Register initial tools
  for (const { tool, handler } of tools) {
    registerTool(tool, handler);
  }

  //─────────────────────────────────────────────────────────────────────────────
  // Server Lifecycle
  //─────────────────────────────────────────────────────────────────────────────

  async function start(): Promise<number> {
    // Run onStart hook if provided
    if (options.onStart) {
      await options.onStart();
    }

    return new Promise((resolve, reject) => {
      server = app.listen(port, host, () => {
        const addr = server!.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : port;
        console.log(`${ts()} \n${'═'.repeat(60)}`);
        console.log(`${ts()}   🚀 ${name} MCP Server v${version}`);
        console.log(`${ts()} ${'═'.repeat(60)}`);
        console.log(`${ts()}   📡 Listening on ${host}:${actualPort}`);
        console.log(`${ts()}   🔧 Tools registered: ${rpcHandler.getTools().length}`);
        const healthHost = host === '0.0.0.0' ? 'localhost' : host;
        console.log(`${ts()}   📊 Health check: http://${healthHost}:${actualPort}/health`);
        console.log(`${ts()} ${'═'.repeat(60)}\n`);
        resolve(actualPort);
      });
      server.on('error', reject);
    });
  }

  async function stop(): Promise<void> {
    if (rateLimitCleanupInterval) {
      clearInterval(rateLimitCleanupInterval);
      rateLimitCleanupInterval = null;
    }
    return new Promise((resolve, reject) => {
      if (server) {
        server.close((err) => {
          if (err) {
            reject(err);
          } else {
            console.log(`${ts()} 🛑 ${name} server stopped`);
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }

  //─────────────────────────────────────────────────────────────────────────────
  // Return Server Instance
  //─────────────────────────────────────────────────────────────────────────────

  return {
    app,
    rpcHandler,
    registerTool,
    start,
    stop,
  };
}

//═══════════════════════════════════════════════════════════════════════════════
// Internal Helpers
//═══════════════════════════════════════════════════════════════════════════════

// Double-HMAC: avoids length-leak since timingSafeEqual requires equal-length buffers.
// Keyed by `expected` so the comparison is constant-time regardless of input lengths.
function safeTokenCompare(provided: string, expected: string): boolean {
  const hmac = (data: string) => createHmac('sha256', expected).update(data).digest();
  return timingSafeEqual(hmac(provided), hmac(expected));
}

//═══════════════════════════════════════════════════════════════════════════════
// Helper Functions
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a text response for tool results
 * @param text - Text content to return
 * @returns Tool result with text content
 */
export function textResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text }],
  };
}

/**
 * Create a JSON response for tool results
 * @param data - Data object to serialize as JSON
 * @returns Tool result with JSON-formatted text
 */
export function jsonResult<T>(data: T): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * Create an error response for tool results
 * @param message - Error message to return
 * @returns Tool result marked as error
 */
export function errorResult(message: string): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}
