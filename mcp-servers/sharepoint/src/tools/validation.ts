/**
 * Validation helpers for tool parameters.
 */

import { withResultValidation, type ToolResult, type ToolsCallResult } from '@speedwave/mcp-shared';

export type { ToolResult };

/** Permitted characters in a Microsoft Graph id segment: alphanumerics, dashes, underscores, dots. */
const GRAPH_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Render a received value for inclusion in a teaching error message.
 * @param value - the value that failed validation
 */
function summarizeReceived(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return `"${value}"`;
  return String(value);
}

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
      ? `Get a valid ${fieldName} from ${sourceTool} instead of guessing one.`
      : `A valid ${fieldName} contains only letters, digits, '.', '_', '-' (max 128 chars).`;
    return {
      success: false,
      error: {
        code: 'INVALID_ID',
        message: `Invalid ${fieldName} (received: ${summarizeReceived(value)}). ${nextStep}`,
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
