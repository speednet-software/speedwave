/**
 * GitLab: Close Issue
 *
 * Closes an issue.
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'closeIssue',
  category: 'write',
  description: 'Close an issue',
  keywords: ['gitlab', 'issue', 'close', 'resolve', 'done'],
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
          state: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `await gitlab.closeIssue({ project_id: "speedwave/core", issue_iid: 42 })`,
  inputExamples: [
    {
      description: 'Close issue',
      input: { project_id: 'my-group/my-project', issue_iid: 123 },
    },
  ],
  service: 'gitlab',
  deferLoading: true,
};

/**
 * Execute the closeIssue tool.
 * @param params - Tool parameters
 * @param params.project_id - Project ID or path
 * @param params.issue_iid - Issue IID
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.closeIssue - Closes the specified issue
 * @returns Promise resolving to closed issue or error
 */
export async function execute(
  params: { project_id: number | string; issue_iid: number },
  context: { gitlab: { closeIssue: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; issue?: unknown; error?: string }> {
  const { project_id, issue_iid } = params;

  if (!project_id || !issue_iid) {
    return {
      success: false,
      error: 'Missing required fields: project_id, issue_iid',
    };
  }

  try {
    const result = await context.gitlab.closeIssue(params);
    return {
      success: true,
      issue: result,
    };
  } catch (error) {
    return handleExecutionError('closeIssue', params as Record<string, unknown>, error);
  }
}
