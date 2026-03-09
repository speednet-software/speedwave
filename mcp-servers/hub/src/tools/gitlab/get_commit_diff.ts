/**
 * GitLab: Get Commit Diff
 *
 * Get file changes (diff) for a specific commit.
 * @param {number|string} project_id - Project ID or path
 * @param {string} commit_sha - Commit SHA (full or short)
 * @returns {object} Commit diff
 * @example
 * // Get commit diff
 * const diff = await gitlab.getCommitDiff({
 *   project_id: "speedwave/core",
 *   commit_sha: "abc123"
 * });
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'getCommitDiff',
  category: 'read',
  service: 'gitlab',
  description: 'Get file changes (diff) for a specific commit',
  keywords: ['gitlab', 'commit', 'diff', 'changes', 'files', 'git'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: ['number', 'string'],
        description: "Project ID (numeric) or path (e.g., 'group/project')",
      },
      commit_sha: { type: 'string', description: 'Commit SHA (full or short)' },
    },
    required: ['project_id', 'commit_sha'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      diffs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            old_path: { type: 'string' },
            new_path: { type: 'string' },
            new_file: { type: 'boolean' },
            deleted_file: { type: 'boolean' },
            diff: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const diff = await gitlab.getCommitDiff({ project_id: "speedwave/core", commit_sha: "abc123" })`,
  inputExamples: [
    {
      description: 'Minimal: get commit diff by short SHA',
      input: { project_id: 'my-group/my-project', commit_sha: 'abc123' },
    },
    {
      description: 'Partial: diff by full SHA',
      input: { project_id: 'web-app', commit_sha: 'abc123def456789' },
    },
    {
      description: 'Full: diff for specific project',
      input: { project_id: 'backend-api', commit_sha: 'def456' },
    },
  ],
  deferLoading: true,
};

/**
 * Diff entry representing file changes in a commit.
 * @interface DiffEntry
 */
interface DiffEntry {
  old_path: string;
  new_path: string;
  a_mode: string;
  b_mode: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  diff: string;
}

/**
 * Executes the get_commit_diff tool to retrieve file changes for a specific commit.
 * @param params - Tool parameters containing project_id and commit_sha
 * @param params.project_id - Project ID or path
 * @param params.commit_sha - Git commit SHA
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.getCommitDiff - Function to get commit diffs
 * @returns Promise resolving to array of diff entries or error
 */
export async function execute(
  params: { project_id: number | string; commit_sha: string },
  context: { gitlab: { getCommitDiff: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; diff?: DiffEntry[]; error?: string }> {
  const { project_id, commit_sha } = params;

  if (!project_id || !commit_sha) {
    return {
      success: false,
      error: 'Missing required fields: project_id, commit_sha',
    };
  }

  try {
    const result = await context.gitlab.getCommitDiff(params);

    return {
      success: true,
      diff: Array.isArray(result) ? result : [],
    };
  } catch (error) {
    return handleExecutionError('getCommitDiff', params as Record<string, unknown>, error);
  }
}
