/**
 * Validation helpers re-exporting the shared Family-A wrapper.
 */

import {
  withResultValidation,
  notConfiguredMessage,
  missingParamResult,
  type ResultValidationOptions,
  type ToolResult,
  type ToolsCallResult,
} from '@speedwave/mcp-shared';
import type { SlackClients } from '../client.js';

export type { ToolResult };
export { missingParamResult };

/**
 * Gate: returns NOT_CONFIGURED when clients._tokensStatus is 'missing'.
 * @param clients - Slack client container
 */
export function withClients(clients: SlackClients) {
  return <T>(handler: (c: SlackClients, p: T) => Promise<ToolResult>) =>
    async (params: T): Promise<ToolResult> => {
      if (clients._tokensStatus === 'missing') {
        return {
          success: false,
          error: {
            code: 'NOT_CONFIGURED',
            message: notConfiguredMessage('Slack'),
          },
        };
      }
      return handler(clients, params);
    };
}

/**
 * Wrap handler with parameter validation (pretty-printed JSON output) and
 * optional required-param enforcement driven by the tool's `inputSchema.required`.
 * @param handler - Tool handler function.
 * @param options - Optional required-param list and tool name for teaching errors.
 */
export function withValidation<T>(
  handler: (params: T) => ToolResult | Promise<ToolResult>,
  options?: ResultValidationOptions
): (params: Record<string, unknown>) => Promise<ToolsCallResult> {
  return withResultValidation(handler, 2, options);
}
