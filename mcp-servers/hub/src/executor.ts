/**
 * Executes model-generated JavaScript in a restricted AsyncFunction sandbox: forbidden-pattern
 * validation, prototype-chain hardening (ADR-029), timeout, PII tokenization, container isolation.
 */

import { IToolResult } from './hub-types.js';
import { tokenizePII, detokenizePII, createPIIContext, PIIContext } from './pii-tokenizer.js';
import { type AllBridges, initializeAllBridges, callWorker } from './http-bridge.js';
import { TIMEOUTS, ts } from '@speedwave/mcp-shared';
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
  getToolMetadata,
  WrapWithAuditFn,
  PrepareParamsFn,
  WrapBridgeCallFn,
} from './tool-registry.js';
import { sandboxGlobalName } from './service-list.js';
import { toCamelCase } from './tool-discovery.js';

// ── Global Bridge State ───────────────────────────────────────────────────────────────────────

let bridgesInitialized = false;

/** Initialize HTTP bridges to workers (called once at startup); throws on init failure. */
export async function initializeBridges(): Promise<void> {
  if (bridgesInitialized) return;

  try {
    await initializeAllBridges();
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
  bridgesInitialized = testBridges !== null;
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

// Captured at module load, executor-internal not user code; FORBIDDEN_PATTERNS applies to input.
/* c8 ignore next */
const AsyncFunction: new (...args: string[]) => (...a: unknown[]) => Promise<unknown> =
  Object.getPrototypeOf(async function () {}).constructor;

/**
 * Forbidden patterns in user code (security)
 * These are checked before execution
 */
const FORBIDDEN_PATTERNS = [
  // Code injection
  /\beval\s*\(/,
  /\bFunction\s*\(/,
  // Module loading
  /\brequire\s*\(/,
  /\bimport\s*\(/,
  // Process / runtime access
  /\bprocess\b/,
  /\bglobalThis\b/,
  /\bglobal\b/,
  /\b__dirname\b/,
  /\b__filename\b/,
  /\bchild_process\b/,
  // Network / filesystem access
  /\bfs\s*\./,
  /\bnet\s*\./,
  /\bhttp[s]?\s*\./,
  // Prototype chain traversal prevention (ADR-029)
  /\.constructor\b/,
  /\.__proto__\b/,
  /\bgetPrototypeOf\b/,
  /\bsetPrototypeOf\b/,
  /\bProxy\s*\(/,
  /\bReflect\b/,
  // Bracket-notation bypasses (ADR-029)
  /\[\s*['"`]constructor['"`]\s*\]/,
  /\[\s*['"`]__proto__['"`]\s*\]/,
  /\[\s*['"`]prototype['"`]\s*\]/,
];

// ── Audit Logging ─────────────────────────────────────────────────────────────────────────────

/** Operation category derived from tool annotations */
type AuditCategory = 'READ' | 'WRITE' | 'DELETE';

/**
 * Derive audit category from a tool's registry annotations (service, camelCase tool name).
 * @param service - Service name (e.g. 'redmine', 'gitlab').
 * @param tool - camelCase tool method name (e.g. 'createIssue').
 */
function deriveAuditCategory(service: string, tool: string): AuditCategory {
  const meta = getToolMetadata(service, tool);
  const ann = meta?.annotations;
  if (!ann) return 'WRITE';
  if (ann.readOnlyHint) return 'READ';
  if (ann.destructiveHint) return 'DELETE';
  return 'WRITE';
}

/**
 * Single audit log entry
 */
interface AuditEntry {
  /** ISO timestamp when the tool was called */
  timestamp: string;
  /** Operation category derived from tool annotations (READ, WRITE, DELETE) */
  category: AuditCategory;
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
  log: (service: string, tool: string, params: unknown) => void;
}

/** Create audit context: logs each tool call; PII Tokenizer protects sensitive data first. */
function createAuditContext(): AuditContext {
  const entries: AuditEntry[] = [];
  return {
    log: (service, tool, params) => {
      const category = deriveAuditCategory(service, tool);
      const entry: AuditEntry = {
        timestamp: new Date().toISOString(),
        category,
        service,
        tool,
        params: (params ?? {}) as Record<string, unknown>,
      };
      entries.push(entry);
      // ts() is the SSOT log prefix; the ISO timestamp stays in the structured AuditEntry.
      console.log(`${ts()} [${category}] ${service}.${tool}(${JSON.stringify(params ?? {})})`);
    },
  };
}

/**
 * Validate code before execution; returns an error message when a forbidden pattern is found.
 * @param code - The JavaScript code to validate.
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

// ── Error Formatting ──────────────────────────────────────────────────────────────────────────

/**
 * Formats an error to a readable string, handling object `.message` values (e.g. GitBeaker).
 * @param error - The error to format (Error object, plain object, or primitive).
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

/** True when NODE_ENV=development or DEBUG is set. */
function isDevelopmentMode(): boolean {
  const nodeEnv = process.env.NODE_ENV;
  const debug = process.env.DEBUG;
  return nodeEnv === 'development' || Boolean(debug);
}

/**
 * Logs minimal error info in production; full stack traces in development (NODE_ENV/DEBUG).
 * @param context - Context identifier (e.g. service name).
 * @param error - The error to log.
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
 * True when `name` can serve as an AsyncFunction parameter (valid, non-reserved identifier).
 * Reserved words (`class`, `await`, …) pass the shape check but throw at construction.
 * @param name - Candidate sandbox global name.
 */
function isValidSandboxGlobal(name: string): boolean {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return false;
  try {
    new AsyncFunction(name, '');
    return true;
  } catch {
    return false;
  }
}

/**
 * Create tool wrappers (PII tokenization, audit logging) for sandbox execution, per service.
 * @param piiContext - PII tokenization context for this execution.
 * @param auditContext - Audit logging context for tracking tool calls.
 * @param executionStartTime - Start time of execution (Date.now()).
 * @param timeoutMs - Total timeout for this execution in milliseconds.
 */
function createToolWrappers(
  piiContext: PIIContext,
  auditContext: AuditContext,
  executionStartTime: number,
  timeoutMs: number
) {
  /** Remaining timeout for worker calls; at least MIN_TIMEOUT_MS so short operations complete. */
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
   * Generic wrapper for bridge calls with PII handling; `serviceName` labels error reports.
   * @param bridgeCall - Function that makes the bridge call to execute.
   * @param serviceName - Name of the service being called for error reporting.
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
   * Wrap a tool with audit logging: logs service, tool name, and parameters for each call.
   * @param service - Service name for audit tracking (e.g. 'gitlab', 'slack').
   * @param tool - Tool name for audit tracking (e.g. 'getMrFull', 'sendChannel').
   * @param fn - Function to wrap with audit logging.
   */
  const wrapWithAudit: WrapWithAuditFn = <TParams, TResult>(
    service: string,
    tool: string,
    fn: (params: TParams) => Promise<TResult>
  ) => {
    return async (params: TParams): Promise<TResult> => {
      auditContext.log(service, tool, params);
      return fn(params);
    };
  };

  // ── Generate tool wrappers from registry (SSOT) ──────────────────────────────────────────────

  type ServiceTools = Record<string, (params?: Record<string, unknown>) => Promise<unknown>>;

  const tools: Record<string, ServiceTools> = {};

  for (const service of SERVICE_NAMES) {
    if (!enabled.has(service)) continue;
    const bridge = serviceBridges[service];
    /* c8 ignore next — bridge is set above in the serviceBridges loop for every enabled service */
    if (!bridge) continue;

    const globalName = sandboxGlobalName(service);
    if (!isValidSandboxGlobal(globalName)) {
      console.error(
        `${ts()} [executor] Service '${service}' maps to invalid sandbox global '${globalName}' ` +
          `(reserved word or empty); skipping. Rename the plugin slug.`
      );
      continue;
    }
    if (
      Object.prototype.hasOwnProperty.call(tools, globalName) ||
      RESERVED_SANDBOX_GLOBALS.has(globalName)
    ) {
      console.error(
        `${ts()} [executor] Service '${service}' sandbox global '${globalName}' collides with an ` +
          `existing global; skipping. Rename the plugin slug.`
      );
      continue;
    }

    tools[globalName] = buildExecutorWrappers(
      service,
      bridge,
      wrapWithAudit,
      prepareParams,
      wrapBridgeCall,
      service === 'os' ? disabledOs : undefined
    );
  }

  return tools;
}

// ── Parallel Execution Helpers (Anthropic "Advanced Tool Use" pattern) ──────────────────────────

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
 * Execute operations in parallel with partial failure support: `{ results, errors }`.
 * @param operations - Array of promises to execute in parallel.
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
 * Non-service globals injected into every sandbox. Kept as one object so
 * RESERVED_SANDBOX_GLOBALS derives its names from it without drift.
 */
const STATIC_SANDBOX_GLOBALS = {
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
  batch,
  allSettled: Promise.allSettled.bind(Promise),
  paginate,
  collectPages,
  findInPages,
  countInPages,
  filterPages,
  mapPages,
  takeFromPages,
};

/** Global names a service must not shadow: the static helpers above plus `console`. */
const RESERVED_SANDBOX_GLOBALS: ReadonlySet<string> = new Set([
  ...Object.keys(STATIC_SANDBOX_GLOBALS),
  'console',
]);

/**
 * Levenshtein edit distance, capped for speed since candidate lists are short method names.
 * @param a - First string.
 * @param b - Second string.
 */
function levenshteinLite(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));

  for (let i = 0; i < rows; i++) dp[i][0] = i;
  for (let j = 0; j < cols; j++) dp[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }

  return dp[rows - 1][cols - 1];
}

/** Longest attempted name worth suggesting for; bounds the DP cost on attacker-sized input. */
const MAX_SUGGESTION_INPUT_LENGTH = 100;

/**
 * Find the N closest candidate names to an attempted name by edit distance (ascending),
 * dropping suggestions whose best distance exceeds half the attempted name's length.
 * @param attempted - The name that failed to resolve.
 * @param candidates - Available names to rank against.
 * @param limit - Maximum number of suggestions to return.
 */
export function closestMatches(attempted: string, candidates: string[], limit = 3): string[] {
  if (attempted.length > MAX_SUGGESTION_INPUT_LENGTH) return [];
  const maxDistance = Math.max(1, Math.floor(attempted.length / 2));
  const attemptedLower = attempted.toLowerCase();
  return [...candidates]
    .filter((c) => Math.abs(c.length - attempted.length) <= maxDistance)
    .map((c) => ({ name: c, distance: levenshteinLite(attemptedLower, c.toLowerCase()) }))
    .filter((c) => c.distance <= maxDistance)
    .sort((x, y) => x.distance - y.distance || x.name.localeCompare(y.name))
    .slice(0, limit)
    .map((c) => c.name);
}

/**
 * Execute code in sandbox, using AsyncFunction for async/await support.
 * @param params - Code execution parameters.
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
        /* c8 ignore next — validateCode always sets error when returning invalid */
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

  // Prepare sandbox context — spread all service tools (built-in + plugins) dynamically
  const sandboxContext: Record<string, unknown> = {
    ...tools,
    console: {
      log: (...args: unknown[]) => console.log(`${ts()} [sandbox]`, ...args),
      warn: (...args: unknown[]) => console.warn(`${ts()} [sandbox]`, ...args),
      error: (...args: unknown[]) => console.error(`${ts()} [sandbox]`, ...args),
    },
    ...STATIC_SANDBOX_GLOBALS,
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
    const contextKeys = Object.keys(sandboxContext);
    const contextValues = Object.values(sandboxContext);

    const fn = new AsyncFunction(...contextKeys, wrappedCode);

    // Execute with timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Execution timeout (${timeoutMs}ms)`)), timeoutMs);
    });

    const result = await Promise.race([fn(...contextValues), timeoutPromise]);

    const executionMs = Date.now() - startTime;

    return {
      success: true,
      data: result,
      metadata: {
        timestamp: new Date().toISOString(),
        executionMs,
        service: 'code-executor',
        ...(syntaxWarning && { warning: syntaxWarning }),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown execution error';

    // Log the error with original code for debugging
    console.error(`${ts()} ❌ Execution error: ${message}`);
    console.error(`${ts()}    Code: ${code.substring(0, 200)}${code.length > 200 ? '...' : ''}`);

    // Redact every absolute POSIX/Windows host path regardless of preceding punctuation;
    // keep user-code positions like "<anonymous>:3:7", they teach where the snippet broke.
    let sanitizedMessage = message
      .replace(
        /(?<![A-Za-z0-9_\-.\\])(?:(?:\/[a-zA-Z0-9_\-.]+)+|(?:[A-Za-z]:\\|\\\\)(?:[a-zA-Z0-9_\-.]+\\)*[a-zA-Z0-9_\-.]+)/g,
        '[file]'
      )
      .replace(/\[file\]:\d+:\d+/g, '[file]')
      .replace(/(\/[^\s:'"]+):\d+:\d+/g, '$1')
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

        if (availableMethods.length > 0 && attemptedMethod.length <= MAX_SUGGESTION_INPUT_LENGTH) {
          const suggestions = closestMatches(attemptedMethod, availableMethods);
          const didYouMean =
            suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : '';
          sanitizedMessage = `${serviceName}.${attemptedMethod} is not a function.${didYouMean} Available ${serviceName} methods: ${availableMethods.join(', ')}`;
        }
      }
    }

    // Detect underscore notation: "service_method is not defined"
    const underscoreMatch = message.match(/^([\w]+)_([\w_]+) is not defined$/);
    if (underscoreMatch) {
      const [, serviceName, methodName] = underscoreMatch;

      const serviceTools = sandboxContext[serviceName as keyof typeof sandboxContext];

      if (serviceTools && typeof serviceTools === 'object') {
        const camelMethod = toCamelCase(methodName);
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

    // Dashed slug used verbatim: `my-plugin.foo()` parses as `my - plugin.foo()` → `my is not defined`.
    // The undefined name is only the first dash-segment, so list every service sharing it.
    const notDefinedMatch = message.match(/^([A-Za-z_$][\w$]*) is not defined$/);
    if (notDefinedMatch) {
      const [, name] = notDefinedMatch;
      const dashed = [...getEnabledServices()].filter(
        (s) => s.includes('-') && s.split('-')[0] === name
      );
      if (dashed.length > 0) {
        const mapping = dashed.map((s) => `'${s}' → ${sandboxGlobalName(s)}`).join(', ');
        sanitizedMessage = `${name} is not defined. A dashed service slug is camelCased into its sandbox global (${mapping}). Call e.g. ${sandboxGlobalName(dashed[0])}.method(), not ${name}-…().`;
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

// ── Test Exports ──────────────────────────────────────────────────────────────────────────────

/**
 * Export formatErrorMessage for testing purposes only.
 * @internal
 */
export { formatErrorMessage as _formatErrorMessage };

/**
 * Export deriveAuditCategory for testing purposes only.
 * @internal
 */
export { deriveAuditCategory as _deriveAuditCategory };
