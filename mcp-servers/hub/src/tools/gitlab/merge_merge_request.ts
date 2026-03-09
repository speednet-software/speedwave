/**
 * GitLab: Merge Merge Request
 *
 * Merge (accept) a merge request into target branch.
 * Use auto_merge to wait for pipeline success.
 * @param {number|string} project_id - Project ID or path
 * @param {number} mr_iid - Merge request IID
 * @param {boolean} [auto_merge=false] - Merge automatically when pipeline succeeds
 * @param {boolean} [squash] - Squash commits when merging (default: project setting)
 * @param {boolean} [should_remove_source_branch=false] - Delete source branch after merge
 * @param {string} [sha] - Expected HEAD commit SHA for safety (optional)
 * @returns {object} Merge result
 * @example
 * // Merge immediately
 * await gitlab.mergeMergeRequest({
 *   project_id: "speedwave/core",
 *   mr_iid: 42
 * });
 *
 * // Auto-merge when pipeline passes
 * await gitlab.mergeMergeRequest({
 *   project_id: "speedwave/core",
 *   mr_iid: 42,
 *   auto_merge: true
 * });
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'mergeMergeRequest',
  category: 'write',
  description:
    'Merge (accept) a merge request into target branch. Use auto_merge to wait for pipeline success.',
  keywords: ['gitlab', 'merge', 'request', 'accept', 'complete', 'finish'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: ['number', 'string'],
        description: "Project ID (numeric) or path (e.g., 'group/project')",
      },
      mr_iid: { type: 'number', description: 'Merge request IID' },
      auto_merge: {
        type: 'boolean',
        description: 'Merge automatically when pipeline succeeds (default: false)',
      },
      squash: {
        type: 'boolean',
        description: 'Squash commits when merging (default: project setting)',
      },
      should_remove_source_branch: {
        type: 'boolean',
        description: 'Delete source branch after merge (default: false)',
      },
      sha: { type: 'string', description: 'Expected HEAD commit SHA for safety (optional)' },
    },
    required: ['project_id', 'mr_iid'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      merge_request: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          iid: { type: 'number' },
          state: { type: 'string' },
          merged_at: { type: 'string' },
          merge_commit_sha: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `await gitlab.mergeMergeRequest({ project_id: "speedwave/core", mr_iid: 42, auto_merge: true })`,
  inputExamples: [
    {
      description: 'Minimal: merge immediately',
      input: { project_id: 'my-group/my-project', mr_iid: 123 },
    },
    {
      description: 'Partial: auto-merge when pipeline passes',
      input: { project_id: 'web-app', mr_iid: 456, auto_merge: true },
    },
    {
      description: 'Full: squash and remove branch',
      input: {
        project_id: 'backend-api',
        mr_iid: 42,
        auto_merge: true,
        squash: true,
        should_remove_source_branch: true,
      },
    },
  ],
  service: 'gitlab',
  deferLoading: true,
};

/**
 * Result of merge operation including merge metadata.
 * @interface MergeResult
 */
interface MergeResult {
  id: number;
  iid: number;
  state: string;
  merged_by?: { username: string };
  merged_at?: string;
}

/**
 * Executes the merge_merge_request tool to merge a merge request into target branch.
 * @param params - Tool parameters containing project_id, mr_iid, and optional merge options
 * @param params.project_id - Project ID or path
 * @param params.mr_iid - Merge request IID
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.mergeMergeRequest - Function to merge merge requests
 * @returns Promise resolving to merge result or error
 */
export async function execute(
  params: { project_id: number | string; mr_iid: number; [key: string]: unknown },
  context: { gitlab: { mergeMergeRequest: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; result?: MergeResult; error?: string }> {
  const { project_id, mr_iid } = params;

  if (!project_id || !mr_iid) {
    return {
      success: false,
      error: 'Missing required fields: project_id, mr_iid',
    };
  }

  try {
    const result = await context.gitlab.mergeMergeRequest(params);

    return {
      success: true,
      result: result as MergeResult,
    };
  } catch (error) {
    return handleExecutionError('mergeMergeRequest', params as Record<string, unknown>, error);
  }
}
