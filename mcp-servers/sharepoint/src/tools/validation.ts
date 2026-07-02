/**
 * Validation helpers for tool parameters.
 */

import { withResultValidation, type ToolResult, type ToolsCallResult } from '@speedwave/mcp-shared';

export type { ToolResult };

/** Permitted characters in a Microsoft Graph id segment: alphanumerics, dashes, underscores, dots. */
const GRAPH_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Assert that `value` is a non-empty string matching {@link GRAPH_ID_RE}.
 * Returns `null` on success or a `ToolResult` error on failure.
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
 * Wrap handler with parameter validation (compact JSON output, indent 0).
 * @param handler - Tool handler function.
 */
export function withValidation<T>(
  handler: (params: T) => ToolResult | Promise<ToolResult>
): (params: Record<string, unknown>) => Promise<ToolsCallResult> {
  return withResultValidation(handler, 0);
}
