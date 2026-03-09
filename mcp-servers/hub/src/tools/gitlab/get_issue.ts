/**
 * GitLab: Get Issue
 *
 * Gets detailed information about a specific issue.
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'getIssue',
  category: 'read',
  description: 'Get details about a specific issue',
  keywords: ['gitlab', 'issue', 'get', 'show', 'details'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: ['string', 'number'],
        description: 'Project ID or path',
      },
      issue_iid: {
        type: 'number',
        description: 'Issue IID (internal ID)',
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
          description: { type: 'string' },
          state: { type: 'string' },
          labels: { type: 'array' },
          assignees: { type: 'array' },
          web_url: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const issue = await gitlab.getIssue({ project_id: "speedwave/core", issue_iid: 42 })`,
  inputExamples: [
    {
      description: 'Get issue details',
      input: { project_id: 'my-group/my-project', issue_iid: 123 },
    },
  ],
  service: 'gitlab',
  deferLoading: true,
};

/**
 * Execute the getIssue tool.
 * @param params - Tool parameters
 * @param params.project_id - Project ID or path
 * @param params.issue_iid - Issue IID
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.getIssue - Gets issue details
 * @returns Promise resolving to issue details or error
 */
export async function execute(
  params: { project_id: number | string; issue_iid: number },
  context: { gitlab: { getIssue: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; issue?: unknown; error?: string }> {
  const { project_id, issue_iid } = params;

  if (!project_id || !issue_iid) {
    return {
      success: false,
      error: 'Missing required fields: project_id, issue_iid',
    };
  }

  try {
    const result = await context.gitlab.getIssue(params);
    return {
      success: true,
      issue: result,
    };
  } catch (error) {
    return handleExecutionError('getIssue', params as Record<string, unknown>, error);
  }
}
