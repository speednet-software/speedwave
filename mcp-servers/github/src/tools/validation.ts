/** Validation helpers for GitHub tool parameters (via shared {@link withClientValidation}). */

import {
  withClientValidation,
  ts,
  teachingErrorResult,
  normalizeNumericIdParams,
  type Tool,
  type ToolDefinition,
  type ToolsCallResult,
  type jsonResult,
  type textResult,
} from '@speedwave/mcp-shared';
import { GitHubClient, isExpectedError } from '../client.js';

/**
 * Splits a combined `owner/repo` string passed in `repo` when `owner` is missing, so a `full_name`
 * value round-tripped from `listRepos`/`getRepo` still resolves; an impossible shape is taught, not forwarded.
 * @param params - Raw params object (a copy is returned; input is untouched)
 */
function normalizeOwnerRepo(
  params: Record<string, unknown>
): { ok: true; value: Record<string, unknown> } | { ok: false; error: ToolsCallResult } {
  if (params.owner || typeof params.repo !== 'string' || !params.repo.includes('/')) {
    return { ok: true, value: params };
  }
  const slash = params.repo.indexOf('/');
  const owner = params.repo.slice(0, slash);
  const repo = params.repo.slice(slash + 1);
  if (!owner || !repo || repo.includes('/')) {
    return {
      ok: false,
      error: teachingErrorResult({
        paramName: 'repo',
        received: params.repo,
        nextStep:
          "Pass repo as either a bare repository name (with a separate 'owner' param) or a single 'owner/repo' string with exactly one slash and non-empty segments on both sides.",
      }),
    };
  }
  return { ok: true, value: { ...params, owner, repo } };
}

/**
 * Numeric-id param names for a tool: top-level integer/number inputs, excluding pagination `limit` (clamped, not rejected, out of range).
 * @param tool - The tool whose inputSchema drives the derivation
 */
function numericIdParamNames(tool: Tool): string[] {
  const props = tool.inputSchema.properties as Record<string, { type?: unknown }>;
  return Object.entries(props)
    .filter(([name, s]) => name !== 'limit' && (s?.type === 'number' || s?.type === 'integer'))
    .map(([name]) => name);
}

/**
 * Wraps a tool handler with numeric-id forgiveness from its own inputSchema: a `#`-prefixed or
 * string form of each numeric-id param is coerced, and an exotic value (`"4.5"`, `"0x2A"`) is taught.
 * @param def - The tool definition to wrap
 */
export function withNumericForgiveness(def: ToolDefinition): ToolDefinition {
  const names = numericIdParamNames(def.tool);
  if (names.length === 0) return def;
  const handler = def.handler;
  return {
    tool: def.tool,
    handler: (params, context) => {
      if (!params || typeof params !== 'object') return handler(params, context);
      const normalized = normalizeNumericIdParams(params, names, { prefixes: ['#'] });
      if (!normalized.ok) return Promise.resolve(teachingErrorResult(normalized.error));
      return handler(normalized.value, context);
    },
  };
}

/**
 * Wraps a tool handler with client-presence, owner/repo forgiveness, and error handling.
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
      return handler(c, ownerRepo.value as T);
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
