/** Validation helpers for GitHub tool parameters (via shared {@link withClientValidation}). */

import {
  withClientValidation,
  ts,
  teachingErrorResult,
  type ToolsCallResult,
  type jsonResult,
  type textResult,
} from '@speedwave/mcp-shared';
import { GitHubClient, isExpectedError } from '../client.js';

/** Param names that carry a numeric GitHub ID but should tolerate a leading '#' or a string form. */
const NUMERIC_ID_PARAMS = ['number', 'run_id', 'artifact_id'] as const;

/**
 * Splits a combined `owner/repo` string passed in `repo` when `owner` is missing,
 * so a `full_name` value round-tripped from `listRepos`/`getRepo` still resolves.
 * Teaches the caller instead of silently passing through when the split is malformed
 * (e.g. a leading/trailing slash yields an empty owner or repo segment).
 * @param params - Raw params object (mutated copy is returned; input is untouched)
 */
function normalizeOwnerRepo(
  params: Record<string, unknown>
): { ok: true; value: Record<string, unknown> } | { ok: false; error: ToolsCallResult } {
  if (params.owner || typeof params.repo !== 'string' || !params.repo.includes('/')) {
    return { ok: true, value: params };
  }
  const [owner, ...rest] = params.repo.split('/');
  const repo = rest.join('/');
  if (!owner || !repo) {
    return {
      ok: false,
      error: teachingErrorResult({
        paramName: 'repo',
        received: params.repo,
        nextStep:
          "Pass repo as either a bare repository name (with a separate 'owner' param) or a full 'owner/repo' string with non-empty segments on both sides of the slash.",
      }),
    };
  }
  return { ok: true, value: { ...params, owner, repo } };
}

/**
 * Strips a leading '#' and coerces to a number for params that identify a PR/issue/run/artifact
 * by number. Teaches the caller instead of silently passing through a non-numeric value, so a
 * malformed id fails fast with guidance rather than as an opaque error from the GitHub API.
 * @param params - Raw params object (mutated copy is returned; input is untouched)
 */
function normalizeNumericIds(
  params: Record<string, unknown>
): { ok: true; value: Record<string, unknown> } | { ok: false; error: ToolsCallResult } {
  let result = params;
  for (const key of NUMERIC_ID_PARAMS) {
    const value = result[key];
    if (typeof value !== 'string') continue;
    const stripped = value.replace(/^#/, '').trim();
    const n = stripped === '' ? NaN : Number(stripped);
    if (!Number.isFinite(n)) {
      return {
        ok: false,
        error: teachingErrorResult({
          paramName: key,
          received: value,
          nextStep: `Pass ${key} as a number or a numeric string, optionally prefixed with '#' (e.g. 42 or "#42").`,
        }),
      };
    }
    result = { ...result, [key]: n };
  }
  return { ok: true, value: result };
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
      if (!raw || typeof raw !== 'object') {
        return handler(c, raw as T);
      }
      const ownerRepo = normalizeOwnerRepo(raw);
      if (!ownerRepo.ok) return Promise.resolve(ownerRepo.error);
      const numericIds = normalizeNumericIds(ownerRepo.value);
      if (!numericIds.ok) return Promise.resolve(numericIds.error);
      return handler(c, numericIds.value as T);
    },
    {
      serviceName: 'GitHub',
      formatError: (error) => GitHubClient.formatError(error),
      onUnexpectedError: (error) => {
        const hasOctokitStatus = typeof (error as { status?: unknown } | null)?.status === 'number';
        if (!hasOctokitStatus && !isExpectedError(error)) {
          console.error(`${ts()} Unexpected (non-Octokit) error in GitHub tool handler:`, error);
        }
      },
    }
  );
}
