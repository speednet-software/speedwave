/**
 * Validation Helpers for Tool Parameters
 */

import { ToolsCallResult } from '@speedwave/mcp-shared';

/**
 * Result from a tool handler
 */
export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

function validateParams(params: unknown): params is Record<string, unknown> {
  return params !== null && typeof params === 'object' && !Array.isArray(params);
}

function formatResult(result: ToolResult): ToolsCallResult {
  if (result.success) {
    return { content: [{ type: 'text', text: JSON.stringify(result.data) }] };
  } else {
    return { content: [{ type: 'text', text: JSON.stringify(result.error) }], isError: true };
  }
}

/**
 * Permitted characters in a Microsoft Graph id segment used in page/list/item/column
 * URLs. Graph guids and SharePoint page names are alphanumerics, dashes, and
 * underscores; allowing dots covers some legacy page filenames (e.g. "Home.aspx").
 *
 * Used by the page and list tools to refuse model-supplied ids that contain
 * path separators or URL meta characters (e.g. `"P1/../../drives/X/items"` or
 * `"1?$select=secret"`). This is defense in depth on top of the "no site_id
 * from model" invariant — the worker still controls `site_id`, but every other
 * Graph-path segment comes from the model and must be a single safe token.
 */
const GRAPH_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Assert that `value` is a non-empty string matching {@link GRAPH_ID_RE}.
 * Returns `null` on success or a `ToolResult` error on failure (suitable for
 * early return at the top of a handler).
 * @param value - candidate id from the tool call
 * @param fieldName - parameter name to mention in the error message
 */
export function validateGraphId(value: unknown, fieldName: string): ToolResult | null {
  if (typeof value !== 'string' || !GRAPH_ID_RE.test(value)) {
    return {
      success: false,
      error: {
        code: 'INVALID_ID',
        message: `${fieldName} must match ${GRAPH_ID_RE.source}`,
      },
    };
  }
  return null;
}

/**
 * Wrap handler with parameter validation
 * @param handler - Tool handler function
 */
export function withValidation<T>(
  handler: (params: T) => ToolResult | Promise<ToolResult>
): (params: Record<string, unknown>) => Promise<ToolsCallResult> {
  return async (params: Record<string, unknown>) => {
    if (!validateParams(params)) {
      return formatResult({
        success: false,
        error: { code: 'INVALID_INPUT', message: 'Tool parameters must be a non-null object' },
      });
    }
    try {
      const result = await handler(params as T);
      return formatResult(result);
    } catch (error) {
      return formatResult({
        success: false,
        error: {
          code: 'HANDLER_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  };
}
