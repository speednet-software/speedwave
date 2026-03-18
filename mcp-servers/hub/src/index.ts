#!/usr/bin/env node
/**
 * Speedwave MCP Server - Code Executor
 * Filesystem as API pattern for 98.7% token reduction
 * @module index
 *
 * Based on: Anthropic "Code Execution with MCP" article
 * https://www.anthropic.com/engineering/code-execution-with-mcp
 *
 * This server provides 2 meta-tools instead of 44+ individual tools:
 * 1. search_tools - Progressive discovery (lazy loading)
 * 2. execute_code - JavaScript execution in sandbox
 *
 * Token Reduction:
 * - Before: ~25K tokens (44 tool definitions upfront)
 * - After: ~600 tokens (2 meta-tools)
 * - Reduction: 97.6%
 *
 * Security Model:
 * ✅ AsyncFunction sandbox (restricted globals, no eval/require)
 * ✅ Execution timeout (2 min standard, 5 min for long operations like file transfers)
 * ✅ PII tokenization (sensitive data never reaches model)
 * ✅ Docker network isolation (no exposed ports)
 * ✅ Rate limiting (100 req/min per session)
 */

import express, { Request, Response } from 'express';

// Import MCP infrastructure from shared library
import {
  JSONRPCHandler,
  createSSEStream,
  sendJSONResponse,
  Tool,
  TIMEOUTS,
  ts,
} from '@speedwave/mcp-shared';

// Import handlers
import { createCodeExecutorHandlers } from './handlers.js';

// Import bridge initialization
import { initializeBridges } from './executor.js';

// Import registry initialization
import { initializeRegistry } from './tool-registry.js';

// Import auth token loader
import { loadAuthTokens } from './auth-tokens.js';

//═══════════════════════════════════════════════════════════════════════════════
// Constants & Configuration
//═════════════════════════════════════════════════════════════════════════════════

const PORT = parseInt(process.env.PORT || '3000', 10);

/**
 * MCP server name identifier.
 * @constant {string}
 */
const SERVER_NAME = 'speedwave-code-executor-mcp';

const SERVER_INFO = {
  name: SERVER_NAME,
  version: '1.0.0',
};

//═══════════════════════════════════════════════════════════════════════════════
// MCP Tool Definitions (2 Meta-Tools)
//═══════════════════════════════════════════════════════════════════════════════

const TOOLS: Tool[] = [
  {
    name: 'search_tools',
    description: `Search available MCP tools by keyword. Returns tool names, descriptions, and optionally full schemas.
Use this to discover tools before executing code. Start with 'names_only' for efficiency.

Built-in services: slack, sharepoint, redmine, gitlab, os. Plugin services (if enabled) are also searchable.

Examples:
- search_tools({ query: "slack", detail_level: "names_only" })
- search_tools({ query: "issue", detail_level: "full_schema", service: "redmine" })
- search_tools({ query: "reminders", detail_level: "with_descriptions", service: "os" })
- search_tools({ query: "*", detail_level: "with_descriptions", include_deferred: false })  // core tools only`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: "Search query (e.g., 'slack', 'issue', 'merge request')",
        },
        detail_level: {
          type: 'string',
          enum: ['names_only', 'with_descriptions', 'full_schema'],
          description:
            "Level of detail. Use 'names_only' first, then 'full_schema' for specific tools.",
        },
        service: {
          type: 'string',
          description:
            'Limit search to specific service. Built-in: slack, sharepoint, redmine, gitlab, os. Plugin services also accepted.',
        },
        include_deferred: {
          type: 'boolean',
          description:
            'Include deferred (on-demand) tools (default: true). Set false to get only core tools.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'execute_code',
    description: `Execute JavaScript code (ES2022+) in a secure sandbox with MCP tools.

⚠️ SCHEMA FIRST - MANDATORY WORKFLOW:
Before calling ANY tool for the first time, you MUST:
1. search_tools({ query: "toolName", detail_level: "full_schema", service: "serviceName" })
2. Read the inputSchema and example from the response
3. Use EXACT parameter structure from schema

DO NOT guess parameter formats - always check schema first!

⚠️ ISOLATED SANDBOX: Each execute_code call runs in a fresh sandbox. Variables do NOT persist between calls. Put your entire workflow (fetch IDs → fetch details → process) in a SINGLE code block.

IMPORTANT: Use plain JavaScript, NOT TypeScript. Do NOT use type annotations like ": number[]" or ": string".

GRANULAR TOOLS PATTERN (recommended):
\`\`\`javascript
// Step 1: Get IDs (lightweight, ~100 tokens)
const { ids, total_count } = await redmine.listIssueIds({
  status: "open",
  assigned_to: "me"
});

// Step 2: Get full details for selected issues (batch returns { results, errors })
const { results: issues } = await batch(ids.slice(0, 5).map(id =>
  redmine.getIssueFull({ issue_id: id, include: ["journals", "custom_fields"] })
));

// Step 3: Work with complete data
return issues.filter(i =>
  i.custom_fields?.find(cf => cf.name === "Priority")?.value === "High"
);
\`\`\`

Available globals:
- redmine: listIssueIds, getIssueFull, searchIssueIds, createIssue, updateIssue, ...
- gitlab: listProjectIds, getProjectFull, listMrIds, getMrFull, listPipelineIds, getPipelineFull, ...
- slack: listChannelIds, getChannelMessages, sendChannel
- sharepoint: listFileIds, getFileFull, downloadFile, uploadFile
- os: listReminders, createReminder, listEvents, createEvent, listEmails, sendEmail, listNotes, createNote, ...
- batch(promises): Parallel execution with partial failure support
  ⚠️ Returns { results: T[], errors: [{index, error}] } - ALWAYS destructure!
  ✅ const { results } = await batch([...])
  ❌ const data = await batch([...]); data.map(...) // WRONG: data is not array!
- paginate(): Async generator for large datasets

Example - Cross-service workflow:
\`\`\`javascript
// Get IDs from multiple services
const [issueData, mrData] = await Promise.all([
  redmine.listIssueIds({ status: "open", assigned_to: "me" }),
  gitlab.listMrIds({ project_id: "my-project", state: "opened" })
]);

// Fetch full details in parallel
const { results, errors } = await batch([
  ...issueData.ids.slice(0, 5).map(id => redmine.getIssueFull({ issue_id: id })),
  ...mrData.mrs.slice(0, 5).map(mr => gitlab.getMrFull({ project_id: "my-project", mr_iid: mr.iid }))
]);

return { total: results.length, failed: errors.length };
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'JavaScript code to execute (ES2022+). Do NOT use TypeScript type annotations. Use globals (redmine, slack, gitlab, etc.) directly - no imports needed. Return value is sent to model.',
        },
        timeout_ms: {
          type: 'number',
          description: `Execution timeout in milliseconds (default: ${TIMEOUTS.EXECUTION_MS}ms, max: ${TIMEOUTS.EXECUTION_MS}ms). For long operations (sharepoint.downloadFile, sharepoint.uploadFile) timeout auto-extends to ${TIMEOUTS.LONG_OPERATION_MS}ms.`,
        },
      },
      required: ['code'],
    },
    inputExamples: [
      {
        description: 'Minimal: get IDs only',
        input: {
          code: `const { ids, total_count } = await redmine.listIssueIds({ status: "open" });\nreturn { count: total_count, first_10: ids.slice(0, 10) };`,
        },
      },
      {
        description: 'Partial: get full details for selected items',
        input: {
          code: `const { ids } = await redmine.listIssueIds({ status: "open", assigned_to: "me" });\nconst { results } = await batch(ids.slice(0, 5).map(id => redmine.getIssueFull({ issue_id: id, include: ["custom_fields"] })));\nreturn { results };`,
        },
      },
      {
        description: 'Full: cross-service granular workflow',
        input: {
          code: `const [issueData, mrData] = await Promise.all([\n  redmine.listIssueIds({ status: "open" }),\n  gitlab.listMrIds({ project_id: "my-project", state: "opened" })\n]);\nconst { results } = await batch([\n  ...issueData.ids.slice(0, 3).map(id => redmine.getIssueFull({ issue_id: id })),\n  ...mrData.mrs.slice(0, 3).map(mr => gitlab.getMrFull({ project_id: "my-project", mr_iid: mr.iid }))\n]);\nreturn { total: results.length };`,
        },
      },
    ],
  },
];

//═══════════════════════════════════════════════════════════════════════════════
// HTTP Server Setup
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Main server initialization and startup
 */
async function main() {
  console.log(`${ts()} 🚀 Starting Speedwave Code Executor MCP Server...`);
  console.log(`${ts()} 📊 Token reduction: 44 tools → 2 meta-tools (97.6% reduction)`);

  // Load per-service auth tokens (e.g., for mcp-os on host)
  loadAuthTokens();

  // Initialize dynamic tool registry (fetches tools from workers)
  console.log(`${ts()} 🔧 Initializing dynamic tool registry...`);
  await initializeRegistry();
  console.log(`${ts()} ✅ Tool registry initialized`);

  // Initialize HTTP bridges to workers
  console.log(`${ts()} 🔧 Initializing HTTP bridges to workers...`);
  await initializeBridges();
  console.log(`${ts()} ✅ HTTP bridges initialized`);

  // Create JSON-RPC handler
  const rpcHandler = new JSONRPCHandler(SERVER_INFO);

  // Create handlers
  const handlers = createCodeExecutorHandlers({ timeoutMs: TIMEOUTS.EXECUTION_MS });

  // Register meta-tools
  rpcHandler.registerTool(TOOLS[0], handlers.handleSearchTools);
  rpcHandler.registerTool(TOOLS[1], handlers.handleExecuteCode);

  console.log(`${ts()} ✅ 2 meta-tools registered: search_tools, execute_code`);

  // Create Express app
  const app = express();

  // Security: Disable X-Powered-By header
  app.disable('x-powered-by');

  app.use(express.json({ limit: '1mb' })); // Allow larger payloads for code

  //═══════════════════════════════════════════════════════════════════════════════
  // MCP Protocol Endpoint
  //═══════════════════════════════════════════════════════════════════════════════

  app.post('/', async (req: Request, res: Response) => {
    try {
      // Get session ID from header
      const sessionId = req.headers['mcp-session-id'] as string | null;

      // Process JSON-RPC request
      const response = await rpcHandler.processRequest(req.body, sessionId);

      // Handle session ID in response
      interface ResponseWithMeta {
        _meta?: { sessionId?: string };
      }
      const resultWithMeta = response.result as ResponseWithMeta | undefined;
      if (resultWithMeta?._meta?.sessionId) {
        const newSessionId = resultWithMeta._meta.sessionId;
        delete resultWithMeta._meta;
        res.setHeader('Mcp-Session-Id', newSessionId);
        console.log(`${ts()} ✅ New session created: ${newSessionId.substring(0, 8)}...`);
      }

      // Check Accept header to determine response format
      const acceptHeader = req.headers.accept || '';

      if (acceptHeader.includes('text/event-stream')) {
        const stream = createSSEStream(res);
        stream.sendMessage(response);
        stream.close();
      } else {
        sendJSONResponse(res, response);
      }
    } catch (error) {
      // Generate unique error ID for tracking in Sentry/logs
      const errorId = Math.random().toString(16).substring(2, 10).toUpperCase();

      console.error(`${ts()} ❌ Error processing MCP request [${errorId}]:`, error);

      res.status(500).json({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32603,
          message: 'Internal server error',
          data: {
            errorId, // Include error ID for Sentry tracking
            timestamp: new Date().toISOString(),
          },
        },
      });
    }
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // OAuth Registration Endpoint (Not Implemented)
  //═══════════════════════════════════════════════════════════════════════════════

  app.post('/register', (req: Request, res: Response) => {
    res.status(501).json({
      error: 'OAuth not implemented',
      message: 'This MCP server does not require OAuth authentication.',
      mcp_endpoint: '/',
    });
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Health Check Endpoint
  //═══════════════════════════════════════════════════════════════════════════════

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Start Server
  //═══════════════════════════════════════════════════════════════════════════════

  // inside container — must be reachable from Docker network
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`${ts()} ✅ Speedwave Code Executor MCP Server running on port ${PORT}`);
    console.log(`${ts()} 📡 MCP Protocol: Streamable HTTP (JSON-RPC 2.0 + optional SSE)`);
    console.log(
      `${ts()} 🔒 Security: AsyncFunction sandbox, PII tokenization, Docker network isolation`
    );
    console.log(`${ts()} 📋 Endpoints:`);
    console.log(`${ts()}    POST /              - MCP protocol endpoint`);
    console.log(`${ts()}    GET  /health        - Health check`);
    console.log(`${ts()} 🛠️  Meta-tools:`);
    console.log(`${ts()}    1. search_tools     - Progressive discovery (lazy loading)`);
    console.log(`${ts()}    2. execute_code     - JavaScript execution in sandbox`);
  });

  // Graceful shutdown handler
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

// Run server
main().catch((error) => {
  console.error(`${ts()} ❌ Fatal error:`, error);
  process.exit(1);
});
