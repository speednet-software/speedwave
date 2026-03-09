/**
 * Validation Helpers for Tool Parameters
 *
 * Shared validation utilities following the Speedwave MCP pattern.
 * Provides error handling and result formatting for all tool handlers.
 */

import { ToolsCallResult } from '../../../shared/dist/index.js';

/**
 * Standard tool result structure used throughout Gemini tools
 */
export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Validates that params is a non-null object (not array).
 * @param params - Tool parameters
 */
function validateParams(params: unknown): params is Record<string, unknown> {
  return params !== null && typeof params === 'object' && !Array.isArray(params);
}

/**
 * Formats ToolResult to MCP ToolsCallResult format.
 * @param result - Tool result
 */
function formatResult(result: ToolResult): ToolsCallResult {
  if (result.success) {
    return {
      content: [{ type: 'text', text: JSON.stringify(result.data) }],
    };
  } else {
    return {
      content: [{ type: 'text', text: JSON.stringify(result.error) }],
      isError: true,
    };
  }
}

/**
 * Higher-order function that wraps tool handlers with validation and error handling.
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
