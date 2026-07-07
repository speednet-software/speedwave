/**
 * Validation helpers for GitLab tool parameters; delegates to {@link withClientValidation}.
 */

import {
  withClientValidation,
  ts,
  teachingErrorResult,
  type ToolsCallResult,
  type jsonResult,
  type textResult,
} from '@speedwave/mcp-shared';
import { GitLabClient } from '../client.js';

/**
 * Wrap a tool handler with client-presence and error handling.
 * @param client - GitLab client instance (null when the service is not configured)
 * @param handler - Tool handler function
 */
export function withValidation<T>(
  client: GitLabClient | null,
  handler: (
    client: GitLabClient,
    params: T
  ) => Promise<ReturnType<typeof jsonResult> | ReturnType<typeof textResult> | ToolsCallResult>
): (params: T) => Promise<ToolsCallResult> {
  return withClientValidation(client, handler, {
    serviceName: 'GitLab',
    formatError: (error) => GitLabClient.formatError(error),
    onUnexpectedError: (error) => {
      const name = error instanceof Error ? error.name : '';
      if (!name.startsWith('Gitbeaker')) {
        console.error(`${ts()} Unexpected (non-GitBeaker) error in GitLab tool handler:`, error);
      }
    },
  });
}

/**
 * Result of normalizing an IID-like input: either a valid number, or a teaching
 * error result to return immediately without calling the client.
 */
export type NormalizedIid = { ok: true; value: number } | { ok: false; error: ToolsCallResult };

/**
 * Normalizes an issue/MR/pipeline/job IID accepted as a number, a numeric string
 * ("42"), or a '#'-prefixed string ("#42"); teaches the caller on anything else.
 * @param value - Raw IID value received from tool params.
 * @param paramName - Name of the parameter being normalized (for the error message).
 */
export function normalizeIid(value: unknown, paramName: string): NormalizedIid {
  const raw = typeof value === 'string' ? value.replace(/^#/, '').trim() : value;
  const n = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
  if (typeof n !== 'number' || Number.isNaN(n) || !Number.isFinite(n)) {
    return {
      ok: false,
      error: teachingErrorResult({
        paramName,
        received: value,
        nextStep: `Pass ${paramName} as a number or a numeric string, optionally prefixed with '#' (e.g. 42 or "#42").`,
      }),
    };
  }
  return { ok: true, value: n };
}
