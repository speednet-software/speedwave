/**
 * GitLab: List Issues
 *
 * Lists issues in a project with optional filters.
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'listIssues',
  category: 'read',
  description: 'List issues in a project',
  keywords: ['gitlab', 'issues', 'list', 'bugs', 'tasks'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: ['string', 'number'],
        description: 'Project ID or path',
      },
      state: {
        type: 'string',
        description: 'Filter by state (opened, closed, all)',
      },
      labels: {
        type: 'string',
        description: 'Comma-separated label names',
      },
      assignee_username: {
        type: 'string',
        description: 'Filter by assignee username',
      },
      limit: {
        type: 'number',
        description: 'Max results (default 20)',
      },
    },
    required: ['project_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      issues: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            iid: { type: 'number' },
            title: { type: 'string' },
            state: { type: 'string' },
            labels: { type: 'array' },
            web_url: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const issues = await gitlab.listIssues({ project_id: "speedwave/core", state: "opened" })`,
  inputExamples: [
    {
      description: 'List open issues',
      input: { project_id: 'my-group/my-project', state: 'opened' },
    },
    {
      description: 'List issues by label',
      input: { project_id: 'my-group/my-project', labels: 'bug,urgent' },
    },
  ],
  service: 'gitlab',
  deferLoading: true,
};

/**
 * Execute the listIssues tool.
 * @param params - Tool parameters
 * @param params.project_id - Project ID or path
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.listIssues - Lists project issues
 * @returns Promise resolving to issues list or error
 */
export async function execute(
  params: { project_id: number | string; [key: string]: unknown },
  context: { gitlab: { listIssues: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; issues?: unknown[]; error?: string }> {
  const { project_id } = params;

  if (!project_id) {
    return {
      success: false,
      error: 'Missing required field: project_id',
    };
  }

  try {
    const result = await context.gitlab.listIssues(params);
    return {
      success: true,
      issues: Array.isArray(result) ? result : [],
    };
  } catch (error) {
    return handleExecutionError('listIssues', params as Record<string, unknown>, error);
  }
}
