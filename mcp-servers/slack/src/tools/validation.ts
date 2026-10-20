/**
 * Validation helpers re-exporting the shared Family-A wrapper.
 */

import {
  withResultValidation,
  notConfiguredMessage,
  teachingToolResult,
  type ToolResult,
  type ToolsCallResult,
} from '@speedwave/mcp-shared';
import { InvalidParamError, formatSlackError, type SlackClients } from '../client.js';

export type { ToolResult };

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
 * Wrap handler with parameter validation (pretty-printed JSON output).
 * @param handler - Tool handler function.
 */
export function withValidation<T>(
  handler: (params: T) => ToolResult | Promise<ToolResult>
): (params: Record<string, unknown>) => Promise<ToolsCallResult> {
  return withResultValidation(handler, 2);
}

/**
 * Failure result for a thrown error: a rejected parameter becomes a teaching error, anything else a Slack-formatted failure under `code`.
 * @param code - Failure code of the tool for a non-parameter error.
 * @param error - The thrown value.
 */
export function failureResult(code: string, error: unknown): ToolResult {
  if (error instanceof InvalidParamError) {
    return teachingToolResult(error.teaching);
  }
  return { success: false, error: { code, message: formatSlackError(error) } };
}
