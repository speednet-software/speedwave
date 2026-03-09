/**
 * Validation Helpers for Tool Parameters
 */

import { ToolsCallResult } from '../../../shared/dist/index.js';

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
