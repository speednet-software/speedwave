/**
 * GitLab: Get MR Changes
 *
 * Get file changes (diff) for a merge request.
 * @param {number|string} project_id - Project ID or path
 * @param {number} mr_iid - Merge request IID
 * @returns {object} Array of file changes with diffs
 * @example
 * // Get MR diff
 * const changes = await gitlab.getMrChanges({
 *   project_id: "speedwave/core",
 *   mr_iid: 42
 * });
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'getMrChanges',
  category: 'read',
  description: 'Get file changes (diff) for a merge request',
  keywords: ['gitlab', 'merge', 'request', 'diff', 'changes', 'files'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: ['number', 'string'],
        description: "Project ID (numeric) or path (e.g., 'group/project')",
      },
      mr_iid: { type: 'number', description: 'Merge request IID' },
    },
    required: ['project_id', 'mr_iid'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      changes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            old_path: { type: 'string' },
            new_path: { type: 'string' },
            new_file: { type: 'boolean' },
            renamed_file: { type: 'boolean' },
            deleted_file: { type: 'boolean' },
            diff: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const changes = await gitlab.getMrChanges({ project_id: "speedwave/core", mr_iid: 42 })`,
  inputExamples: [
    {
      description: 'Minimal: get MR changes',
      input: { project_id: 'my-group/my-project', mr_iid: 123 },
    },
    {
      description: 'Partial: changes by path',
      input: { project_id: 'web-app', mr_iid: 456 },
    },
    {
      description: 'Full: changes by numeric ID',
      input: { project_id: 789, mr_iid: 42 },
    },
  ],
  service: 'gitlab',
  deferLoading: true,
};

/**
 * File change entry in a merge request diff.
 * @interface Change
 */
interface Change {
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
 * Executes the get_mr_changes tool to retrieve file changes (diff) for a merge request.
 * @param params - Tool parameters containing project_id and mr_iid
 * @param params.project_id - Project ID or path
 * @param params.mr_iid - Merge request IID
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.getMrChanges - Function to get merge request changes
 * @returns Promise resolving to array of file changes or error
 */
export async function execute(
  params: { project_id: number | string; mr_iid: number },
  context: { gitlab: { getMrChanges: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; changes?: Change[]; error?: string }> {
  const { project_id, mr_iid } = params;

  if (!project_id || !mr_iid) {
    return {
      success: false,
      error: 'Missing required fields: project_id, mr_iid',
    };
  }

  try {
    const result = await context.gitlab.getMrChanges(params);
    const data = result as { changes?: Change[] };

    return {
      success: true,
      changes: data.changes || [],
    };
  } catch (error) {
    return handleExecutionError('getMrChanges', params as Record<string, unknown>, error);
  }
}
