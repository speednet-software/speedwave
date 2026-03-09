/**
 * GitLab: Show Merge Request
 *
 * Get detailed information about a merge request including diff summary.
 * @param {number|string} project_id - Project ID or path
 * @param {number} mr_iid - Merge request IID (internal ID, not global ID)
 * @returns {object} Merge request details
 * @example
 * // Get MR details
 * const mr = await gitlab.showMergeRequest({
 *   project_id: "speedwave/core",
 *   mr_iid: 42
 * });
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'getMrFull',
  category: 'read',
  description: 'Get full merge request details including diff summary',
  keywords: ['gitlab', 'merge', 'request', 'mr', 'show', 'detail', 'full'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['number', 'string'], description: 'Project ID or path' },
      mr_iid: { type: 'number', description: 'Merge request IID (internal ID)' },
      include: {
        type: 'array',
        items: { type: 'string' },
        description: "Additional data to include (e.g., ['changes', 'commits'])",
      },
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
          title: { type: 'string' },
          description: { type: 'string' },
          state: { type: 'string' },
          source_branch: { type: 'string' },
          target_branch: { type: 'string' },
          author: { type: 'object', properties: { username: { type: 'string' } } },
          assignees: {
            type: 'array',
            items: { type: 'object', properties: { username: { type: 'string' } } },
          },
          reviewers: {
            type: 'array',
            items: { type: 'object', properties: { username: { type: 'string' } } },
          },
          web_url: { type: 'string' },
          created_at: { type: 'string' },
          updated_at: { type: 'string' },
          changes_count: { type: 'string' },
          has_conflicts: { type: 'boolean', description: 'Whether the MR has merge conflicts' },
          merge_status: {
            type: 'string',
            description: 'Simple merge status (can_be_merged, cannot_be_merged, etc.)',
          },
          detailed_merge_status: {
            type: 'string',
            description: 'Detailed merge status (mergeable, conflict, checking, etc.)',
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const mr = await gitlab.getMrFull({ project_id: "speedwave/core", mr_iid: 123 })`,
  inputExamples: [
    {
      description: 'Get MR details',
      input: { project_id: 'my-group/my-project', mr_iid: 42 },
    },
  ],
  service: 'gitlab',
  deferLoading: true,
};

/**
 * Detailed merge request information including metadata and diff summary.
 * @interface MergeRequestDetail
 */
interface MergeRequestDetail {
  id: number;
  iid: number;
  title: string;
  description: string;
  state: string;
  source_branch: string;
  target_branch: string;
  author: { username: string };
  assignees: Array<{ username: string }>;
  reviewers: Array<{ username: string }>;
  web_url: string;
  created_at: string;
  updated_at: string;
  changes_count: string;
}

/**
 * Executes the show_merge_request tool to retrieve detailed merge request information.
 * @param params - Tool parameters containing project_id and mr_iid
 * @param params.project_id - Project ID or path
 * @param params.mr_iid - Merge request IID
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.showMergeRequest - Function to show merge request details
 * @returns Promise resolving to merge request details or error
 */
export async function execute(
  params: { project_id: number | string; mr_iid: number },
  context: { gitlab: { showMergeRequest: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; merge_request?: MergeRequestDetail; error?: string }> {
  const { project_id, mr_iid } = params;

  if (!project_id || !mr_iid) {
    return {
      success: false,
      error: 'Missing required fields: project_id, mr_iid',
    };
  }

  try {
    const result = await context.gitlab.showMergeRequest(params);

    return {
      success: true,
      merge_request: result as MergeRequestDetail,
    };
  } catch (error) {
    return handleExecutionError('getMrFull', params as Record<string, unknown>, error);
  }
}
