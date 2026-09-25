#!/usr/bin/env node
/**
 * Speedwave MCP Hub — code executor exposing 2 meta-tools instead of 44+ (Anthropic's Code
 * Execution with MCP pattern). Security: AsyncFunction sandbox, PII tokenization, net isolation.
 */

import express, { Express, NextFunction, Request, Response } from 'express';

import {
  JSONRPCHandler,
  handleMCPPost,
  handleMCPDelete,
  readSessionId,
  TIMEOUTS,
  ts,
} from '@speedwave/mcp-shared';

import { createCodeExecutorHandlers } from './handlers.js';

import { metaToolRegistrations } from './meta-tools.js';

import { initializeBridges } from './executor.js';

import { initializeRegistry } from './tool-registry.js';

import { loadAuthTokens } from './auth-tokens.js';

import { loadPolicy } from './policy.js';

const PORT = parseInt(process.env.PORT || '3000', 10);

/** MCP server name identifier. */
const SERVER_NAME = 'speedwave-code-executor-mcp';

const SERVER_INFO = {
  name: SERVER_NAME,
  version: '1.0.0',
};

/** Sliding-window rate limit: max requests per session per window. */
const HUB_RATE_LIMIT_MAX = 100;
/** Rate-limit window in milliseconds (1 minute). */
const HUB_RATE_LIMIT_WINDOW_MS = 60_000;

/** Main server initialization and startup. */
/* c8 ignore start: server bootstrap (registry/bridge init + listen); exercised by container run */
async function main() {
  console.log(`${ts()} 🚀 Starting Speedwave Code Executor MCP Server...`);
  console.log(`${ts()} 📊 Token reduction: 44 tools → 2 meta-tools (97.6% reduction)`);

  loadAuthTokens();

  loadPolicy();

  console.log(`${ts()} 🔧 Initializing dynamic tool registry...`);
  await initializeRegistry();
  console.log(`${ts()} ✅ Tool registry initialized`);

  console.log(`${ts()} 🔧 Initializing HTTP bridges to workers...`);
  await initializeBridges();
  console.log(`${ts()} ✅ HTTP bridges initialized`);

  const rpcHandler = new JSONRPCHandler(SERVER_INFO);

  const handlers = createCodeExecutorHandlers({ timeoutMs: TIMEOUTS.EXECUTION_MS });

  for (const { tool, handler } of metaToolRegistrations(handlers)) {
    rpcHandler.registerTool(tool, handler);
  }

  console.log(`${ts()} ✅ 2 meta-tools registered: search_tools, execute_code`);

  const app = createHubApp(rpcHandler);

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`${ts()} ✅ Speedwave Code Executor MCP Server running on port ${PORT}`);
    console.log(`${ts()} 📡 MCP Protocol: Streamable HTTP (JSON-RPC 2.0 + optional SSE)`);
    console.log(
      `${ts()} 🔒 Security: AsyncFunction sandbox, PII tokenization, container network isolation, ${HUB_RATE_LIMIT_MAX} req/min per session`
    );
    console.log(`${ts()} 📋 Endpoints:`);
    console.log(`${ts()}    POST /              - MCP protocol endpoint`);
    console.log(`${ts()}    DELETE /            - Session termination`);
    console.log(`${ts()}    GET  /health        - Health check`);
    console.log(`${ts()} 🛠️  Meta-tools:`);
    console.log(`${ts()}    1. search_tools     - Progressive discovery (lazy loading)`);
    console.log(`${ts()}    2. execute_code     - JavaScript execution in sandbox`);
  });

  const gracefulShutdown = (signal: string) => {
    console.log(`${ts()} \n📴 Received ${signal}, shutting down gracefully...`);
    server.close(() => {
      console.log(`${ts()} ✅ Server closed, all connections terminated`);
      process.exit(0);
    });

    setTimeout(() => {
      console.error(`${ts()} ⚠️  Graceful shutdown timeout, forcing exit`);
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}
/* c8 ignore stop */

/**
 * Sliding-window rate limiter keyed by MCP session id (IP fallback before a
 * session exists). Returns 429 with Retry-After once the window cap is reached.
 */
export function createSessionRateLimiter() {
  const hits = new Map<string, number[]>();
  return function rateLimit(req: Request, res: Response, next: NextFunction): void {
    const key = readSessionId(req) ?? req.ip ?? 'unknown';
    const now = Date.now();
    const valid = (hits.get(key) ?? []).filter((t) => now - t < HUB_RATE_LIMIT_WINDOW_MS);

    if (valid.length >= HUB_RATE_LIMIT_MAX) {
      console.warn(`${ts()} RATE_LIMIT ${req.method} from session ${key}`);
      res.setHeader('Retry-After', Math.ceil(HUB_RATE_LIMIT_WINDOW_MS / 1000).toString());
      res.status(429).json({ error: 'Too Many Requests' });
      return;
    }

    valid.push(now);
    hits.set(key, valid);
    for (const [k, stamps] of hits) {
      if (k !== key && stamps.every((t) => now - t >= HUB_RATE_LIMIT_WINDOW_MS)) hits.delete(k);
    }
    next();
  };
}

/**
 * Create the Hub Express app with MCP transport endpoints.
 * @param rpcHandler - JSON-RPC handler to process incoming requests
 */
export function createHubApp(rpcHandler: JSONRPCHandler): Express {
  const app = express();

  app.disable('x-powered-by');

  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  app.use(createSessionRateLimiter());

  app.post('/', async (req: Request, res: Response) => {
    await handleMCPPost(rpcHandler, req, res);
  });

  app.delete('/', (req: Request, res: Response) => {
    handleMCPDelete(req, res);
  });

  app.all('/', (_req: Request, res: Response) => {
    res.setHeader('Allow', 'POST, DELETE');
    res.status(405).json({ error: 'Method Not Allowed' });
  });

  return app;
}

/* c8 ignore next 4 */
main().catch((error) => {
  console.error(`${ts()} Fatal error:`, error);
  process.exit(1);
});
