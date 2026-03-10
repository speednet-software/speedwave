/**
 * Code Executor - AsyncFunction with Restricted Context
 * @module executor
 *
 * Executes model-generated JavaScript code in a restricted context.
 * Security is provided by:
 * - Forbidden pattern validation (no eval, require, process, fs, etc.)
 * - Restricted context (only whitelisted globals injected)
 * - Execution timeout
 * - PII tokenization (sensitive data replaced before reaching model)
 * - Docker container isolation (no-new-privileges, cap_drop: ALL)
 *
 * Security Model:
 * ✅ AsyncFunction with restricted globals (no process, require, fs)
 * ✅ Forbidden pattern validation before execution
 * ✅ Timeout enforcement
 * ✅ Docker isolation (container has no tokens, read-only fs)
 * ✅ Error sanitization
 *
 * Architecture:
 * - HTTP bridge to isolated MCP workers
 * - Hub has NO tokens - only orchestrates
 * - Workers have per-service token isolation
 * - Graceful degradation (unavailable services return null)
 */

import { IToolResult, ToolCategory } from './hub-types.js';
import { tokenizePII, detokenizePII, createPIIContext, PIIContext } from './pii-tokenizer.js';
import { AllBridges, initializeAllBridges, getBridgeStatus, callWorker } from './http-bridge.js';
import { TIMEOUTS, ts } from '../../shared/dist/index.js';
import { addAutoReturn } from './auto-return.js';
import {
  paginate,
  collectPages,
  findInPages,
  countInPages,
  filterPages,
  mapPages,
  takeFromPages,
} from './paginate.js';
import {
  buildExecutorWrappers,
  buildServiceBridge,
  SERVICE_NAMES,
  getEnabledServices,
  getDisabledOsCategories,
  WrapWithAuditFn,
  PrepareParamsFn,
  WrapBridgeCallFn,
} from './tool-registry.js';

//═══════════════════════════════════════════════════════════════════════════════
// Global Bridge State
//═══════════════════════════════════════════════════════════════════════════════

let bridges: AllBridges | null = null;
let bridgesInitialized = false;

/**
 * Initialize HTTP bridges to workers (called once at startup)
 * @returns Promise that resolves when bridges are initialized
 * @throws {Error} Error if bridge initialization fails
 */
export async function initializeBridges(): Promise<void> {
  if (bridgesInitialized) return;

  try {
    bridges = await initializeAllBridges();
    bridgesInitialized = true;
  } catch (error) {
    console.error(`${ts()} Failed to initialize HTTP bridges:`, error);
    throw error;
  }
}

/**
 * Set bridges directly (for testing only)
 * @param testBridges - Bridge instances to use for testing, or null to clear
 */
export function _setBridgesForTesting(testBridges: AllBridges | null): void {
  bridges = testBridges;
  bridgesInitialized = testBridges !== null;
}

/**
 * Get bridge status for health checks
 * @returns Object mapping service names to their availability status (null = unknown)
 */
export function getWorkerStatus(): Record<string, boolean | null> {
  if (!bridges) return {};
  return getBridgeStatus(bridges);
}

/**
 * Parameters for code execution
 */
export interface ExecuteCodeParams {
  /** JavaScript code to execute */
  code: string;
  /** Execution timeout in milliseconds */
  timeoutMs: number;
}

/**
 * Forbidden patterns in user code (security)
 * These are checked before execution
 */
const FORBIDDEN_PATTERNS = [
  /\beval\s*\(/,
  /\bFunction\s*\(/,
  /\brequire\s*\(/,
  /\bimport\s*\(/, // Dynamic import
  /\bprocess\b/,
  /\bglobalThis\b/,
  /\b__dirname\b/,
  /\b__filename\b/,
  /\bchild_process\b/,
  /\bfs\s*\./,
  /\bnet\s*\./,
  /\bhttp[s]?\s*\./,
];

//═══════════════════════════════════════════════════════════════════════════════
// Audit Logging
// Based on: Anthropic "Advanced Tool Use" - Tool Category + Audit
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Single audit log entry
 */
interface AuditEntry {
  /** ISO timestamp when the tool was called */
  timestamp: string;
  /** Category of the operation */
  category: ToolCategory;
  /** Service name (redmine, gitlab, slack, etc.) */
  service: string;
  /** Tool name that was called */
  tool: string;
  /** Parameters passed to the tool */
  params: Record<string, unknown>;
}

/**
 * Audit context for tracking tool executions
 */
interface AuditContext {
  /** Log a tool execution */
  log: (category: ToolCategory, service: string, tool: string, params: unknown) => void;
  /** Get summary of all logged operations */
  getSummary: () => { read: number; write: number; delete: number; entries: AuditEntry[] };
}

/**
 * Create audit context for tracking tool executions
 * Logs each tool call with timestamp, category, and parameters
 * Note: Sensitive data is protected by PII Tokenizer before reaching Claude.
 * Local console logs are not sanitized as they stay within Docker container.
 * @returns A new audit context instance
 */
function createAuditContext(): AuditContext {
  const entries: AuditEntry[] = [];
  return {
    log: (category, service, tool, params) => {
      const entry: AuditEntry = {
        timestamp: new Date().toISOString(),
        category,
        service,
        tool,
        params: (params ?? {}) as Record<string, unknown>,
      };
      entries.push(entry);
      // Format: [2024-11-27 14:32:15] [WRITE] redmine.updateIssue({ issue_id: 123 })
      const auditTs = entry.timestamp.replace('T', ' ').substring(0, 19);
      console.log(
        `${ts()} [${auditTs}] [${category.toUpperCase()}] ${service}.${tool}(${JSON.stringify(params ?? {})})`
      );
    },
    getSummary: () => ({
      read: entries.filter((e) => e.category === 'read').length,
      write: entries.filter((e) => e.category === 'write').length,
      delete: entries.filter((e) => e.category === 'delete').length,
      entries,
    }),
  };
}

/**
 * Validate code before execution
 * @param code - The JavaScript code to validate
 * @returns Validation result with error message if invalid
 */
function validateCode(code: string): { valid: boolean; error?: string } {
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(code)) {
      return {
        valid: false,
        error: `Forbidden pattern detected: ${pattern.source}`,
      };
    }
  }
  return { valid: true };
}

//═══════════════════════════════════════════════════════════════════════════════
// Error Formatting
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Formats an error into a human-readable string message.
 * Handles cases where error.message is an object (common with API errors like GitBeaker).
 * @param {unknown} error - The error to format (Error object, plain object, or primitive)
 * @returns {string} A formatted error message suitable for display
 * @example
 * formatErrorMessage(new Error('Simple error')) // → 'Simple error'
 * formatErrorMessage({ message: { error: 'API failed' } }) // → '{"error":"API failed"}'
 */
function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    // Handle object messages (common with GitBeaker/API errors)
    if (typeof error.message === 'object' && error.message !== null) {
      return JSON.stringify(error.message);
    }
    return error.message || 'Unknown error';
  }

  if (typeof error === 'object' && error !== null) {
    return JSON.stringify(error);
  }

  return String(error);
}

/**
 * Check if we're running in development mode.
 * Development mode is enabled when NODE_ENV=development or DEBUG is set.
 * @returns {boolean} True if in development mode
 */
function isDevelopmentMode(): boolean {
  const nodeEnv = process.env.NODE_ENV;
  const debug = process.env.DEBUG;
  return nodeEnv === 'development' || Boolean(debug);
}

/**
 * Log error with conditional verbosity based on environment.
 * Production: logs minimal error info (name, message, code).
 * Development (NODE_ENV=development or DEBUG set): logs full stack traces.
 * @param {string} context - Context identifier (e.g., service name)
 * @param {unknown} error - The error to log
 */
function logErrorDebug(context: string, error: unknown): void {
  const isDev = isDevelopmentMode();

  if (error instanceof Error) {
    const code = 'code' in error ? (error as { code?: string }).code : undefined;
    const info = {
      name: error.name,
      message: error.message,
      ...(code && { code }),
    };
    console.error(`${ts()} [${context}] Error:`, info);

    // Only log stack traces in development mode
    if (isDev && error.stack) {
      console.error(`${ts()}`, error.stack);
    }
  } else {
    console.error(`${ts()} [${context}] Error:`, error);
  }
}

/**
 * Create tool wrappers for sandbox execution
 * These wrap HTTP bridge calls with PII tokenization and audit logging.
 *
 * ARCHITECTURE: Uses buildExecutorWrappers from tool-registry.ts
 * - Tool metadata (name, category, service) is Single Source of Truth
 * - Wrappers are generated dynamically from registry
 * - No manual duplication of method definitions
 * - Timeout propagation: remaining time budget passed to each worker call
 * @param piiContext - PII tokenization context for this execution
 * @param auditContext - Audit logging context for tracking tool calls
 * @param executionStartTime - Start time of execution (Date.now())
 * @param timeoutMs - Total timeout for this execution in milliseconds
 * @returns Object containing tool wrappers for all services
 */
function createToolWrappers(
  piiContext: PIIContext,
  auditContext: AuditContext,
  executionStartTime: number,
  timeoutMs: number
) {
  /**
   * Calculate remaining timeout for worker calls.
   * Returns at least MIN_TIMEOUT_MS to allow short operations to complete.
   */
  const getRemainingTimeout = (): number => {
    const elapsed = Date.now() - executionStartTime;
    const remaining = timeoutMs - elapsed;
    return Math.max(TIMEOUTS.MIN_MS, remaining);
  };

  // Create bridges with timeout context (bridges are created per-execution for timeout tracking)
  type ServiceBridges = Record<
    string,
    Record<string, (params?: Record<string, unknown>) => Promise<unknown>>
  >;
  const enabled = getEnabledServices();
  const disabledOs = getDisabledOsCategories();
  const serviceBridges: ServiceBridges = {};
  for (const service of SERVICE_NAMES) {
    if (!enabled.has(service)) continue;
    serviceBridges[service] = buildServiceBridge(service, callWorker, getRemainingTimeout);
  }

  /**
   * Generic wrapper for bridge calls with PII handling
   * @param bridgeCall - Function that makes the bridge call to execute
   * @param serviceName - Name of the service being called for error reporting
   */
  const wrapBridgeCall: WrapBridgeCallFn = async <T>(
    bridgeCall: () => Promise<T>,
    serviceName: string
  ): Promise<T> => {
    try {
      const result = await bridgeCall();
      // Tokenize result (replace sensitive data with tokens)
      return tokenizePII(result, piiContext) as T;
    } catch (error) {
      logErrorDebug(serviceName, error);
      const message = formatErrorMessage(error);
      console.error(`${ts()} [${serviceName}] Bridge call failed:`, message);
      throw new Error(`${serviceName}: ${message}`);
    }
  };

  /**
   * Detokenize and validate params helper
   * @param params - Parameters containing tokenized PII data to be detokenized
   */
  const prepareParams: PrepareParamsFn = <T>(params: T): T => {
    return detokenizePII(params, piiContext) as T;
  };

  /**
   * Wrap tool with audit logging
   * Logs category, service, tool name, and parameters for each call
   * @param category - Tool category for audit classification (e.g., 'read', 'write')
   * @param service - Service name for audit tracking (e.g., 'gitlab', 'slack')
   * @param tool - Tool name for audit tracking (e.g., 'getMrFull', 'sendChannel')
   * @param fn - Function to wrap with audit logging
   */
  const wrapWithAudit: WrapWithAuditFn = <TParams, TResult>(
    category: ToolCategory,
    service: string,
    tool: string,
    fn: (params: TParams) => Promise<TResult>
  ) => {
    return async (params: TParams): Promise<TResult> => {
      auditContext.log(category, service, tool, params);
      return fn(params);
    };
  };

  //═════════════════════════════════════════════════════════════════════════════
  // Generate tool wrappers from registry (SSOT)
  //═════════════════════════════════════════════════════════════════════════════

  type ServiceTools = Record<string, (params?: Record<string, unknown>) => Promise<unknown>>;

  const tools: Record<string, ServiceTools> = {};

  for (const service of SERVICE_NAMES) {
    if (!enabled.has(service)) continue;
    const bridge = serviceBridges[service];
    if (bridge) {
      tools[service] = buildExecutorWrappers(
        service,
        bridge,
        wrapWithAudit,
        prepareParams,
        wrapBridgeCall,
        service === 'os' ? disabledOs : undefined
      );
    }
  }

  return {
    slack: tools.slack,
    sharepoint: tools.sharepoint,
    redmine: tools.redmine,
    gitlab: tools.gitlab,
    os: tools.os,
  };
}

//═══════════════════════════════════════════════════════════════════════════════
// Parallel Execution Helpers
// Based on: Anthropic "Advanced Tool Use" pattern
// Eliminates 19+ inference passes when orchestrating 20+ tool calls
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Batch result interface for partial failure handling
 */
interface BatchResult<T> {
  /** Successfully resolved results */
  results: T[];
  /** Errors from failed operations with their indices */
  errors: Array<{ index: number; error: string }>;
}

/**
 * Execute operations in parallel with partial failure support
 * Returns structured results: { results: T[], errors: [...] }
 * @param operations - Array of promises to execute in parallel
 * @returns Batch result containing successful results and errors
 * @example
 * const { results, errors } = await batch([
 *   redmine.showIssue({ issue_id: 123 }),
 *   redmine.showIssue({ issue_id: 999 })  // may not exist
 * ]);
 */
const batch = async <T>(operations: Promise<T>[]): Promise<BatchResult<T>> => {
  const settled = await Promise.allSettled(operations);
  const results: T[] = [];
  const errors: Array<{ index: number; error: string }> = [];

  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      results.push(result.value);
    } else {
      errors.push({
        index,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });

  return { results, errors };
};

/**
 * Execute code in sandbox
 * Uses AsyncFunction for async/await support
 * @param params - Code execution parameters
 * @returns Tool result with execution data or error
 */
export async function executeCode(params: ExecuteCodeParams): Promise<IToolResult<unknown>> {
  const { code, timeoutMs } = params;
  const startTime = Date.now();

  // Validate code
  const validation = validateCode(code);
  if (!validation.valid) {
    return {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: validation.error || 'Code validation failed',
        retryable: false,
      },
    };
  }

  // Create PII context for this execution
  const piiContext = createPIIContext();

  // Create audit context for tracking tool executions
  const auditContext = createAuditContext();

  // Create tool wrappers with timeout context
  const tools = createToolWrappers(piiContext, auditContext, startTime, timeoutMs);

  // Prepare sandbox context
  const sandboxContext = {
    slack: tools.slack,
    sharepoint: tools.sharepoint,
    redmine: tools.redmine,
    gitlab: tools.gitlab,
    os: tools.os,
    console: {
      log: (...args: unknown[]) => console.log(`${ts()} [sandbox]`, ...args),
      warn: (...args: unknown[]) => console.warn(`${ts()} [sandbox]`, ...args),
      error: (...args: unknown[]) => console.error(`${ts()} [sandbox]`, ...args),
    },
    JSON,
    Date,
    Math,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Promise,
    Map,
    Set,
    RegExp,
    Error,
    // Parallel Execution Helper (Anthropic Advanced Tool Use pattern)
    batch, // Promise.allSettled wrapper - partial failure support
    allSettled: Promise.allSettled.bind(Promise), // Direct access to Promise.allSettled
    // Pagination Helpers (for large datasets)
    paginate, // Async generator for paginated APIs
    collectPages, // Collect all pages into array
    findInPages, // Find first match across pages
    countInPages, // Count matches across pages
    filterPages, // Filter items across pages
    mapPages, // Map items across pages
    takeFromPages, // Take first N items across pages
  };

  try {
    // Auto-return transformation using AST parser (Acorn)
    // Adds 'return' to last expression if no explicit return exists
    const autoResult = addAutoReturn(code);
    const syntaxWarning = autoResult.parseError
      ? `Code may have syntax errors: ${autoResult.parseError}. Execution may fail.`
      : undefined;
    if (syntaxWarning) {
      console.warn(`${ts()} [executor] ${syntaxWarning}`);
    }
    const transformedCode = autoResult.code;

    // Wrap code in async function
    const wrappedCode = `
      return (async () => {
        ${transformedCode}
      })();
    `;

    // Create async function with sandbox context
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const contextKeys = Object.keys(sandboxContext);
    const contextValues = Object.values(sandboxContext);

    const fn = new AsyncFunction(...contextKeys, wrappedCode);

    // Execute with timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Execution timeout (${timeoutMs}ms)`)), timeoutMs);
    });

    const result = await Promise.race([fn(...contextValues), timeoutPromise]);

    const executionMs = Date.now() - startTime;
    const operations = auditContext.getSummary();

    return {
      success: true,
      data: result,
      metadata: {
        timestamp: new Date().toISOString(),
        executionMs,
        service: 'code-executor',
        operations: {
          read: operations.read,
          write: operations.write,
          delete: operations.delete,
        },
        ...(syntaxWarning && { warning: syntaxWarning }),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown execution error';

    // Log the error with original code for debugging
    console.error(`${ts()} ❌ Execution error: ${message}`);
    console.error(`${ts()}    Code: ${code.substring(0, 200)}${code.length > 200 ? '...' : ''}`);

    // Sanitize error message (remove paths, line numbers)
    let sanitizedMessage = message
      .replace(/\/[a-zA-Z0-9_\-./]+\.(ts|js|json)/g, '[file]')
      .replace(/:\d+:\d+/g, '')
      .substring(0, 500);

    // Smart error enhancement: if "X.Y is not a function", show available methods
    const notFunctionMatch = message.match(/(\w+)\.(\w+) is not a function/);
    if (notFunctionMatch) {
      const [, serviceName, attemptedMethod] = notFunctionMatch;
      const serviceTools = sandboxContext[serviceName as keyof typeof sandboxContext];

      if (serviceTools && typeof serviceTools === 'object') {
        const availableMethods = Object.keys(serviceTools).filter(
          (k) => typeof (serviceTools as Record<string, unknown>)[k] === 'function'
        );

        if (availableMethods.length > 0) {
          sanitizedMessage = `${serviceName}.${attemptedMethod} is not a function. Available ${serviceName} methods: ${availableMethods.join(', ')}`;
        }
      }
    }

    // Smart error enhancement: detect underscore notation "service_method is not defined"
    // Claude sometimes generates service_method instead of service.method
    // Use greedy regex and iteratively validate serviceName against sandboxContext
    const underscoreMatch = message.match(/^([\w]+)_([\w_]+) is not defined$/);
    if (underscoreMatch) {
      let [, serviceName, methodName] = underscoreMatch;

      // Iteratively find correct serviceName in sandboxContext
      while (
        !sandboxContext[serviceName as keyof typeof sandboxContext] &&
        methodName.includes('_')
      ) {
        const parts = methodName.split('_');
        serviceName = serviceName + '_' + parts[0];
        methodName = parts.slice(1).join('_');
      }

      const serviceTools = sandboxContext[serviceName as keyof typeof sandboxContext];

      if (serviceTools && typeof serviceTools === 'object') {
        // Convert underscore method name to camelCase (e.g., save_chunk_result -> saveChunkResult)
        const camelMethod = methodName.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
        const availableMethods = Object.keys(serviceTools).filter(
          (k) => typeof (serviceTools as Record<string, unknown>)[k] === 'function'
        );

        if (availableMethods.includes(camelMethod)) {
          sanitizedMessage = `${serviceName}_${methodName} is not defined. Did you mean: ${serviceName}.${camelMethod}()? Use dot notation, not underscore.`;
        } else {
          sanitizedMessage = `${serviceName}_${methodName} is not defined. Use dot notation: ${serviceName}.method(). Available methods: ${availableMethods.join(', ')}`;
        }
      }
    }

    return {
      success: false,
      error: {
        code: 'EXECUTION_ERROR',
        message: sanitizedMessage,
        retryable: message.includes('timeout'),
      },
    };
  }
}

//═══════════════════════════════════════════════════════════════════════════════
// Test Exports
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Export formatErrorMessage for testing purposes only.
 * @internal
 */
export { formatErrorMessage as _formatErrorMessage };
