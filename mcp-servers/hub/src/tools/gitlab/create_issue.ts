/**
 * GitLab: Create Issue
 *
 * Creates a new issue in a project.
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'createIssue',
  category: 'write',
  description: 'Create a new issue in the project',
  keywords: ['gitlab', 'issue', 'create', 'new', 'bug'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: ['string', 'number'],
        description: 'Project ID or path',
      },
      title: {
        type: 'string',
        description: 'Issue title',
      },
      description: {
        type: 'string',
        description: 'Issue description (Markdown supported)',
      },
      labels: {
        type: 'string',
        description: 'Comma-separated label names',
      },
      assignee_ids: {
        type: 'array',
        items: { type: 'number' },
        description: 'Array of assignee user IDs',
      },
      milestone_id: {
        type: 'number',
        description: 'Milestone ID',
      },
    },
    required: ['project_id', 'title'],
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
          web_url: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const issue = await gitlab.createIssue({ project_id: "speedwave/core", title: "Fix login bug", labels: "bug,urgent" })`,
  inputExamples: [
    {
      description: 'Create simple issue',
      input: {
        project_id: 'my-group/my-project',
        title: 'Add feature X',
      },
    },
    {
      description: 'Create detailed issue',
      input: {
        project_id: 'my-group/my-project',
        title: 'Bug: Login fails',
        description: 'Steps to reproduce...',
        labels: 'bug,priority',
      },
    },
  ],
  service: 'gitlab',
  deferLoading: true,
};

/**
 * Execute the createIssue tool.
 * @param params - Tool parameters
 * @param params.project_id - Project ID or path
 * @param params.title - Issue title
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.createIssue - Creates a new issue
 * @returns Promise resolving to created issue or error
 */
export async function execute(
  params: { project_id: number | string; title: string; [key: string]: unknown },
  context: { gitlab: { createIssue: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; issue?: unknown; error?: string }> {
  const { project_id, title } = params;

  if (!project_id || !title) {
    return {
      success: false,
      error: 'Missing required fields: project_id, title',
    };
  }

  try {
    const result = await context.gitlab.createIssue(params);
    return {
      success: true,
      issue: result,
    };
  } catch (error) {
    return handleExecutionError('createIssue', params as Record<string, unknown>, error);
  }
}
