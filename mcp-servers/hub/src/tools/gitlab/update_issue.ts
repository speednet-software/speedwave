/**
 * GitLab: Update Issue
 *
 * Updates an existing issue.
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'updateIssue',
  category: 'write',
  description: 'Update an existing issue',
  keywords: ['gitlab', 'issue', 'update', 'edit', 'modify'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: ['string', 'number'],
        description: 'Project ID or path',
      },
      issue_iid: {
        type: 'number',
        description: 'Issue IID',
      },
      title: {
        type: 'string',
        description: 'New title',
      },
      description: {
        type: 'string',
        description: 'New description',
      },
      labels: {
        type: 'string',
        description: 'Comma-separated label names',
      },
      state_event: {
        type: 'string',
        description: 'State event (close, reopen)',
      },
    },
    required: ['project_id', 'issue_iid'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      issue: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          iid: { type: 'number' },
          title: { type: 'string' },
          state: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `await gitlab.updateIssue({ project_id: "speedwave/core", issue_iid: 42, title: "Updated title", state_event: "close" })`,
  inputExamples: [
    {
      description: 'Update issue title',
      input: {
        project_id: 'my-group/my-project',
        issue_iid: 123,
        title: 'New title',
      },
    },
    {
      description: 'Close issue',
      input: {
        project_id: 'my-group/my-project',
        issue_iid: 123,
        state_event: 'close',
      },
    },
  ],
  service: 'gitlab',
  deferLoading: true,
};

/**
 * Execute the updateIssue tool.
 * @param params - Tool parameters
 * @param params.project_id - Project ID or path
 * @param params.issue_iid - Issue IID
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.updateIssue - Updates an issue
 * @returns Promise resolving to updated issue or error
 */
export async function execute(
  params: { project_id: number | string; issue_iid: number; [key: string]: unknown },
  context: { gitlab: { updateIssue: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; issue?: unknown; error?: string }> {
  const { project_id, issue_iid } = params;

  if (!project_id || !issue_iid) {
    return {
      success: false,
      error: 'Missing required fields: project_id, issue_iid',
    };
  }

  try {
    const result = await context.gitlab.updateIssue(params);
    return {
      success: true,
      issue: result,
    };
  } catch (error) {
    return handleExecutionError('updateIssue', params as Record<string, unknown>, error);
  }
}
