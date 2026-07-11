/**
 * Shared tool-handler wrappers, SSOT for the two `withValidation` families duplicated across six
 * workers: Family A ({@link withResultValidation}) and Family B ({@link withClientValidation}).
 */

import type { ToolsCallResult } from './types.js';
import { errorResult } from './server.js';
import { notConfiguredMessage } from './errors.js';
import { missingParamResult } from './teaching-errors.js';

// ── Family A — param-shape guard + ToolResult formatting (slack / sharepoint / os) ──

/** Standardized result returned by Family-A tool handlers. */
export interface ToolResult {
  /** Whether the tool execution succeeded. */
  success: boolean;
  /** Result payload on success. */
  data?: unknown;
  /** Error details on failure. */
  error?: { code: string; message: string };
}

/**
 * True iff `params` is a non-null, non-array object.
 * @param params - Value to narrow to a plain object.
 */
function isParamObject(params: unknown): params is Record<string, unknown> {
  return params !== null && typeof params === 'object' && !Array.isArray(params);
}

/**
 * Format a {@link ToolResult} into a {@link ToolsCallResult}; `indent` 0 skips pretty-print.
 * @param result - Handler result.
 * @param indent - `JSON.stringify` indent (slack/os use 2, sharepoint uses 0).
 */
function formatResult(result: ToolResult, indent: number): ToolsCallResult {
  const payload = result.success ? result.data : result.error;
  const text = indent > 0 ? JSON.stringify(payload, null, indent) : JSON.stringify(payload);
  const content = [{ type: 'text' as const, text }];
  return result.success ? { content } : { content, isError: true };
}

/** Optional behavior for {@link withResultValidation}. */
export interface ResultValidationOptions {
  /** Param names that must be present; a missing one short-circuits to a teaching error. */
  required?: readonly string[];
  /** Tool name folded into the missing-param teaching message. */
  toolName?: string;
}

/**
 * True iff a required param value counts as missing (absent, null, or empty string).
 * @param value - The param value to test.
 */
function isMissingRequired(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * Wrap a {@link ToolResult}-returning handler with a param-shape guard, optional
 * `required`-param enforcement (via `options.required`), and uniform error formatting.
 * @param handler - Handler returning a {@link ToolResult} (sync or async).
 * @param indent - `JSON.stringify` indent for the formatted payload (default 2).
 * @param options - Optional required-param list and tool name for teaching errors.
 */
export function withResultValidation<T>(
  handler: (params: T) => ToolResult | Promise<ToolResult>,
  indent = 2,
  options?: ResultValidationOptions
): (params: Record<string, unknown>) => Promise<ToolsCallResult> {
  return async (params: Record<string, unknown>) => {
    if (!isParamObject(params)) {
      return formatResult(
        {
          success: false,
          error: { code: 'INVALID_INPUT', message: 'Tool parameters must be a non-null object' },
        },
        indent
      );
    }
    for (const name of options?.required ?? []) {
      if (isMissingRequired(params[name])) {
        const suffix = options?.toolName ? ` for ${options.toolName}.` : '.';
        return formatResult(
          missingParamResult(name, params[name], `Provide ${name}${suffix}`),
          indent
        );
      }
    }
    try {
      const result = await handler(params as T);
      return formatResult(result, indent);
    } catch (error) {
      return formatResult(
        {
          success: false,
          error: {
            code: 'HANDLER_ERROR',
            message: error instanceof Error ? error.message : String(error),
          },
        },
        indent
      );
    }
  };
}

// ── Family B — null-client gate + error mapping (github / gitlab / atlassian) ──

/** Options for {@link withClientValidation}. */
export interface ClientValidationOptions {
  /** Display name used in the "not configured" message (e.g. `GitLab`). */
  serviceName: string;
  /** Map a thrown error to a user-facing string (e.g. `Client.formatError`). */
  formatError: (error: unknown) => string;
  /** Optional hook for an error that is not a recognised API error; return value ignored. */
  onUnexpectedError?: (error: unknown) => void;
}

/**
 * Wrap a tool handler that requires a non-null client: short-circuits to a "not configured"
 * {@link errorResult} when absent, and turns a thrown error into a sanitized one via `formatError`.
 * @param client - The client, or `null` when the service is unconfigured.
 * @param handler - Handler invoked only when `client` is non-null.
 * @param opts - Service name, error formatter, optional unexpected-error hook.
 */
export function withClientValidation<C, T>(
  client: C | null,
  handler: (client: C, params: T) => Promise<ToolsCallResult>,
  opts: ClientValidationOptions
): (params: T) => Promise<ToolsCallResult> {
  return async (params: T) => {
    if (!client) {
      return errorResult(notConfiguredMessage(opts.serviceName));
    }
    try {
      return await handler(client, params);
    } catch (error) {
      opts.onUnexpectedError?.(error);
      return errorResult(opts.formatError(error));
    }
  };
}
