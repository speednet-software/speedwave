/** Validation helpers for GitHub tool parameters (via shared {@link withClientValidation}). */

import {
  withClientValidation,
  ts,
  type ToolsCallResult,
  type jsonResult,
  type textResult,
} from '@speedwave/mcp-shared';
import { GitHubClient } from '../client.js';

/** Param names that carry a numeric GitHub ID but should tolerate a leading '#' or a string form. */
const NUMERIC_ID_PARAMS = ['number', 'run_id', 'artifact_id'] as const;

/**
 * Splits a combined `owner/repo` string passed in `repo` when `owner` is missing,
 * so a `full_name` value round-tripped from `listRepos`/`getRepo` still resolves.
 * @param params - Raw params object (mutated copy is returned; input is untouched)
 */
function normalizeOwnerRepo(params: Record<string, unknown>): Record<string, unknown> {
  if (params.owner || typeof params.repo !== 'string' || !params.repo.includes('/')) {
    return params;
  }
  const [owner, ...rest] = params.repo.split('/');
  const repo = rest.join('/');
  if (!owner || !repo) return params;
  return { ...params, owner, repo };
}

/**
 * Strips a leading '#' and coerces to a number for params that identify a PR/issue/run/artifact
 * by number, so a user-style '#42' reference does not fail before the handler runs.
 * @param params - Raw params object (mutated copy is returned; input is untouched)
 */
function normalizeNumericIds(params: Record<string, unknown>): Record<string, unknown> {
  let result = params;
  for (const key of NUMERIC_ID_PARAMS) {
    const value = result[key];
    if (typeof value !== 'string') continue;
    const n = Number(value.replace(/^#/, ''));
    if (Number.isFinite(n)) {
      result = { ...result, [key]: n };
    }
  }
  return result;
}

/**
 * Wrap a tool handler with client-presence, param forgiveness, and error handling.
 * @param client - GitHub client instance (null when the service is not configured)
 * @param handler - Tool handler function
 */
export function withValidation<T>(
  client: GitHubClient | null,
  handler: (
    client: GitHubClient,
    params: T
  ) => Promise<ReturnType<typeof jsonResult> | ReturnType<typeof textResult>>
): (params: T) => Promise<ToolsCallResult> {
  return withClientValidation(
    client,
    (c, params: T) => {
      const raw = params as Record<string, unknown>;
      const normalized =
        raw && typeof raw === 'object'
          ? normalizeNumericIds(normalizeOwnerRepo(raw))
          : (raw as Record<string, unknown>);
      return handler(c, normalized as T);
    },
    {
      serviceName: 'GitHub',
      formatError: (error) => GitHubClient.formatError(error),
      onUnexpectedError: (error) => {
        if (typeof (error as { status?: unknown } | null)?.status !== 'number') {
          console.error(`${ts()} Unexpected (non-Octokit) error in GitHub tool handler:`, error);
        }
      },
    }
  );
}
