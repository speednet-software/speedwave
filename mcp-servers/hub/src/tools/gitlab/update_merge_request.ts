/**
 * GitLab: Update Merge Request
 *
 * Update a merge request (title, description, state, labels, target branch).
 * @param {number|string} project_id - Project ID or path
 * @param {number} mr_iid - Merge request IID
 * @param {string} [title] - New title
 * @param {string} [description] - New description (supports Markdown)
 * @param {string} [state_event] - Change state (close or reopen)
 * @param {string} [labels] - Comma-separated label names (replaces existing)
 * @param {string} [target_branch] - New target branch
 * @returns {object} Updated merge request
 * @example
 * // Update title
 * await gitlab.updateMergeRequest({
 *   project_id: "speedwave/core",
 *   mr_iid: 42,
 *   title: "Updated: Add authentication flow"
 * });
 *
 * // Close MR
 * await gitlab.updateMergeRequest({
 *   project_id: "speedwave/core",
 *   mr_iid: 42,
 *   state_event: "close"
 * });
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'updateMergeRequest',
  category: 'write',
  description: 'Update a merge request (title, description, state, labels, target branch)',
  keywords: ['gitlab', 'merge', 'request', 'update', 'edit', 'modify'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: ['number', 'string'],
        description: "Project ID (numeric) or path (e.g., 'group/project')",
      },
      mr_iid: { type: 'number', description: 'Merge request IID' },
      title: { type: 'string', description: 'New title for the merge request' },
      description: { type: 'string', description: 'New description (supports Markdown)' },
      state_event: {
        type: 'string',
        enum: ['close', 'reopen'],
        description: 'Change state (close or reopen the MR)',
      },
      labels: {
        type: 'string',
        description: 'Comma-separated label names (replaces existing labels)',
      },
      target_branch: { type: 'string', description: 'New target branch' },
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
          state: { type: 'string' },
          labels: { type: 'array', items: { type: 'string' } },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `await gitlab.updateMergeRequest({ project_id: "speedwave/core", mr_iid: 42, title: "Updated: Add authentication flow", state_event: "close" })`,
  inputExamples: [
    {
      description: 'Minimal: update MR title',
      input: {
        project_id: 'my-group/my-project',
        mr_iid: 123,
        title: 'feat: Updated authentication',
      },
    },
    {
      description: 'Partial: close MR',
      input: { project_id: 'web-app', mr_iid: 456, state_event: 'close' },
    },
    {
      description: 'Full: update all fields',
      input: {
        project_id: 'backend-api',
        mr_iid: 42,
        title: 'fix: Security patch for auth',
        description: '## Changes\\n- Fixed JWT validation\\n- Added rate limiting',
        labels: 'security,bugfix',
        target_branch: 'main',
      },
    },
  ],
  service: 'gitlab',
  deferLoading: true,
};

/**
 * Executes the update_merge_request tool to modify merge request properties.
 * @param params - Tool parameters containing project_id, mr_iid, and optional update fields
 * @param params.project_id - Project ID or path
 * @param params.mr_iid - Merge request IID
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.updateMergeRequest - Function to update merge requests
 * @returns Promise resolving to success status or error
 */
export async function execute(
  params: { project_id: number | string; mr_iid: number; [key: string]: unknown },
  context: { gitlab: { updateMergeRequest: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; error?: string }> {
  const { project_id, mr_iid } = params;

  if (!project_id || !mr_iid) {
    return {
      success: false,
      error: 'Missing required fields: project_id, mr_iid',
    };
  }

  try {
    await context.gitlab.updateMergeRequest(params);

    return {
      success: true,
    };
  } catch (error) {
    return handleExecutionError('updateMergeRequest', params as Record<string, unknown>, error);
  }
}
