/**
 * Validation helpers re-exporting the shared Family-A wrapper.
 */

import {
  withResultValidation,
  notConfiguredMessage,
  teachingErrorResult,
  type ToolResult,
  type ToolsCallResult,
} from '@speedwave/mcp-shared';
import type { SlackClients } from '../client.js';

export type { ToolResult };

/**
 * Build a MISSING_PARAM {@link ToolResult} naming the param, the received value,
 * and the next step — used to validate required params before calling Slack.
 * Delegates message composition to the shared {@link teachingErrorResult}.
 * @param paramName - Name of the missing/invalid parameter.
 * @param received - The value actually received.
 * @param nextStep - What the caller should do instead.
 */
export function missingParamResult(
  paramName: string,
  received: unknown,
  nextStep: string
): ToolResult {
  const teaching = teachingErrorResult({ paramName, received, nextStep });
  const message = (teaching.content[0].text as string).replace(/^Error: /, '');
  return {
    success: false,
    error: { code: 'MISSING_PARAM', message },
  };
}

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
  return withResultValidation(handler);
}
