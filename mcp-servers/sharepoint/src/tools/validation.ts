/**
 * Validation helpers for tool parameters.
 */

import {
  withResultValidation,
  teachingToolResult,
  type ToolResult,
  type ToolsCallResult,
} from '@speedwave/mcp-shared';

export type { ToolResult };

/** Permitted characters in a Microsoft Graph id segment: alphanumerics, dashes, underscores, dots. */
const GRAPH_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Assert that `value` is a non-empty string matching {@link GRAPH_ID_RE}.
 * Returns `null` on success or a teaching `ToolResult` error on failure that
 * names the bad value and, when known, the tool that supplies a correct one.
 * @param value - candidate id from the tool call
 * @param fieldName - parameter name to mention in the error message
 * @param sourceTool - name of the tool that returns a valid value for this field
 */
export function validateGraphId(
  value: unknown,
  fieldName: string,
  sourceTool?: string
): ToolResult | null {
  if (typeof value !== 'string' || !GRAPH_ID_RE.test(value)) {
    const nextStep = sourceTool
      ? 'Retry with that id instead of guessing one.'
      : `A valid ${fieldName} contains only letters, digits, '.', '_', '-' (max 128 chars).`;
    return teachingToolResult(
      { paramName: fieldName, received: value, correctValueTool: sourceTool, nextStep },
      'INVALID_ID'
    );
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
