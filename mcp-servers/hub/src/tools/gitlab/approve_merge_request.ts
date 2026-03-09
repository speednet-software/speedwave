/**
 * GitLab: Approve Merge Request
 *
 * Approve a merge request (for code review workflows).
 * @param {number|string} project_id - Project ID or path
 * @param {number} mr_iid - Merge request IID
 * @returns {object} Approval status
 * @example
 * // Approve MR
 * await gitlab.approveMergeRequest({
 *   project_id: "speedwave/core",
 *   mr_iid: 42
 * });
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'approveMergeRequest',
  category: 'write',
  description: 'Approve a merge request (for code review workflows)',
  keywords: ['gitlab', 'merge', 'request', 'approve', 'review', 'accept'],
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
      approved: { type: 'boolean' },
      merge_request_iid: { type: 'number' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `await gitlab.approveMergeRequest({ project_id: "speedwave/core", mr_iid: 42 })`,
  inputExamples: [
    {
      description: 'Minimal: approve MR',
      input: { project_id: 'my-group/my-project', mr_iid: 123 },
    },
    {
      description: 'Partial: approve by project path',
      input: { project_id: 'web-app', mr_iid: 456 },
    },
    {
      description: 'Full: approve by numeric ID',
      input: { project_id: 789, mr_iid: 42 },
    },
  ],
  service: 'gitlab',
  deferLoading: true,
};

/**
 * Executes the approve_merge_request tool to approve a merge request in code review workflow.
 * @param params - Tool parameters containing project_id and mr_iid
 * @param params.project_id - Project ID or path
 * @param params.mr_iid - Merge request IID
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.approveMergeRequest - Function to approve merge requests
 * @returns Promise resolving to success status or error
 */
export async function execute(
  params: { project_id: number | string; mr_iid: number },
  context: { gitlab: { approveMergeRequest: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; error?: string }> {
  const { project_id, mr_iid } = params;

  if (!project_id || !mr_iid) {
    return {
      success: false,
      error: 'Missing required fields: project_id, mr_iid',
    };
  }

  try {
    await context.gitlab.approveMergeRequest(params);

    return {
      success: true,
    };
  } catch (error) {
    return handleExecutionError('approveMergeRequest', params as Record<string, unknown>, error);
  }
}
