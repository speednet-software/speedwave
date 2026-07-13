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

/** Permitted characters and length of a Microsoft Graph id segment. */
const GRAPH_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const GRAPH_ID_SPEC = /\[([^\]]+)\]\{(\d+),(\d+)\}/.exec(GRAPH_ID_RE.source);
/** Rule text derived from GRAPH_ID_RE so the message and the regex cannot drift. */
const GRAPH_ID_RULE = GRAPH_ID_SPEC
  ? `${GRAPH_ID_SPEC[2]} to ${GRAPH_ID_SPEC[3]} characters from the set [${GRAPH_ID_SPEC[1]}]`
  : 'a Microsoft Graph id';

/**
 * Assert `value` matches {@link GRAPH_ID_RE}; null on success, else a teaching `ToolResult`.
 * @param value - The value to validate.
 * @param fieldName - Name of the field, used in the error message.
 * @param sourceTool - Optional name of the tool that produces a valid value.
 */
export function validateGraphId(
  value: unknown,
  fieldName: string,
  sourceTool?: string
): ToolResult | null {
  if (typeof value !== 'string' || !GRAPH_ID_RE.test(value)) {
    const nextStep = sourceTool
      ? 'Retry with that id instead of guessing one.'
      : `A valid ${fieldName} is ${GRAPH_ID_RULE}.`;
    return teachingToolResult(
      { paramName: fieldName, received: value, correctValueTool: sourceTool, nextStep },
      'INVALID_ID'
    );
  }
  return null;
}

/**
 * Wrap handler with parameter validation (compact JSON output, indent 0).
 * @param handler - The tool handler to wrap.
 */
export function withValidation<T>(
  handler: (params: T) => ToolResult | Promise<ToolResult>
): (params: Record<string, unknown>) => Promise<ToolsCallResult> {
  return withResultValidation(handler, 0);
}
