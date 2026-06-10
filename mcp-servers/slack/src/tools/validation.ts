/**
 * Validation Helpers for Tool Parameters
 *
 * Thin re-exports of the shared Family-A wrapper ({@link withResultValidation})
 * so Slack tools keep importing a local `withValidation`/`ToolResult`.
 */

import { withResultValidation, type ToolResult, type ToolsCallResult } from '@speedwave/mcp-shared';

export type { ToolResult };

/**
 * Wrap handler with parameter validation (pretty-printed JSON output).
 * @param handler - Tool handler function.
 */
export function withValidation<T>(
  handler: (params: T) => ToolResult | Promise<ToolResult>
): (params: Record<string, unknown>) => Promise<ToolsCallResult> {
  return withResultValidation(handler);
}
