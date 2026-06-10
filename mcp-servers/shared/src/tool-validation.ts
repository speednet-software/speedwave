/**
 * Shared tool-handler wrappers — SSOT for the two `withValidation` families that
 * were duplicated across six workers' `tools/validation.ts`:
 *
 * - Family A ({@link withResultValidation}): param-shape-guard + `ToolResult`
 *   formatting. Used by slack / sharepoint / os, which return a `{ success,
 *   data?, error? }` {@link ToolResult} from each handler.
 * - Family B ({@link withClientValidation}): null-client-gate + error mapping.
 *   Used by github / gitlab / atlassian, whose handlers take a non-null client
 *   and throw on failure.
 * @module shared/tool-validation
 */

import type { ToolsCallResult } from './types.js';
import { errorResult } from './server.js';
import { notConfiguredMessage } from './errors.js';

//═══════════════════════════════════════════════════════════════════════════════
// Family A — param-shape guard + ToolResult formatting (slack / sharepoint / os)
//═══════════════════════════════════════════════════════════════════════════════

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
 * Format a {@link ToolResult} into an MCP {@link ToolsCallResult}.
 * @param result - Handler result.
 * @param indent - `JSON.stringify` indent (slack/os use 2, sharepoint uses 0).
 */
function formatResult(result: ToolResult, indent: number): ToolsCallResult {
  const payload = result.success ? result.data : result.error;
  const text = indent > 0 ? JSON.stringify(payload, null, indent) : JSON.stringify(payload);
  const content = [{ type: 'text' as const, text }];
  return result.success ? { content } : { content, isError: true };
}

/**
 * Wrap a {@link ToolResult}-returning handler with a param-shape guard and
 * uniform error formatting.
 * @template T - The handler's parsed params type.
 * @param handler - Handler returning a {@link ToolResult} (sync or async).
 * @param indent - `JSON.stringify` indent for the formatted payload (default 2).
 */
export function withResultValidation<T>(
  handler: (params: T) => ToolResult | Promise<ToolResult>,
  indent = 2
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

//═══════════════════════════════════════════════════════════════════════════════
// Family B — null-client gate + error mapping (github / gitlab / atlassian)
//═══════════════════════════════════════════════════════════════════════════════

/** Options for {@link withClientValidation}. */
export interface ClientValidationOptions {
  /** Display name used in the "not configured" message (e.g. `GitLab`). */
  serviceName: string;
  /** Map a thrown error to a user-facing string (e.g. `Client.formatError`). */
  formatError: (error: unknown) => string;
  /**
   * Optional hook invoked when a caught error is NOT a recognised API error
   * (a programming bug in the handler) — used to log it at error level so it
   * does not masquerade as a plain API error. Return value is ignored.
   */
  onUnexpectedError?: (error: unknown) => void;
}

/**
 * Wrap a tool handler that requires a non-null client: short-circuits to a
 * "not configured" {@link errorResult} when the client is absent, and turns any
 * thrown error into a sanitized {@link errorResult} via `formatError`.
 * @template C - Client type.
 * @template T - The handler's parsed params type.
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
