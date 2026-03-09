/**
 * Redmine: List Issues
 *
 * List issues from Redmine with optional filtering.
 * Supports filtering by assignee, status, project, and parent.
 * @param {string} [assigned_to] - User identifier (me, user ID, name, email) or 'unassigned'
 * @param {string} [status] - Status name (open, closed, in_progress, etc.) or ID
 * @param {string} [project_id] - Project ID or identifier
 * @param {number} [parent_id] - Parent issue ID (list subtasks only)
 * @param {number} [limit=25] - Maximum number of issues to return (max: 100)
 * @returns {object} Array of issues with metadata
 * @example
 * // List my open issues
 * const { ids, total_count } = await redmine.listIssueIds({
 *   assigned_to: "me",
 *   status: "open"
 * });
 *
 * // List issues in project
 * const projectIssues = await redmine.listIssueIds({
 *   project_id: "speedwave-core"
 * });
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'listIssueIds',
  category: 'read',
  service: 'redmine',
  description:
    'List issue IDs from Redmine with optional filtering (assigned_to, status, project, parent)',
  keywords: ['redmine', 'issues', 'list', 'filter', 'tasks', 'bugs', 'ids'],
  inputSchema: {
    type: 'object',
    properties: {
      assigned_to: {
        type: 'string',
        description: "User identifier (me, user ID, name, email) or 'unassigned'",
      },
      status: { type: 'string', description: 'Status name (open, closed, in_progress) or ID' },
      project_id: { type: 'string', description: 'Project ID or identifier' },
      parent_id: { type: 'number', description: 'Parent issue ID (list subtasks only)' },
      limit: {
        type: 'number',
        description: 'Maximum number of issues (default: 25, max: 100)',
      },
    },
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
            subject: { type: 'string' },
            status: {
              type: 'object',
              properties: { id: { type: 'number' }, name: { type: 'string' } },
            },
            priority: {
              type: 'object',
              properties: { id: { type: 'number' }, name: { type: 'string' } },
            },
            tracker: {
              type: 'object',
              properties: { id: { type: 'number' }, name: { type: 'string' } },
            },
            assigned_to: {
              type: 'object',
              properties: { id: { type: 'number' }, name: { type: 'string' } },
            },
            project: {
              type: 'object',
              properties: { id: { type: 'number' }, name: { type: 'string' } },
            },
          },
        },
      },
      total_count: { type: 'number' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const { ids, total_count } = await redmine.listIssueIds({ status: "open", assigned_to: "me" })`,
  inputExamples: [
    {
      description: 'Minimal: list all issues (with defaults)',
      input: {},
    },
    {
      description: 'Partial: my open issues',
      input: { status: 'open', assigned_to: 'me' },
    },
    {
      description: 'Full: project issues with subtasks',
      input: { project_id: 'my-project', status: 'open', assigned_to: 'me', limit: 50 },
    },
  ],
  deferLoading: false,
};

/**
 * Issue summary from Redmine list.
 * @interface Issue
 */
interface Issue {
  /** Issue ID */
  id: number;
  /** Issue subject/title */
  subject: string;
  /** Issue status information */
  status: { id: number; name: string };
  /** Issue priority information */
  priority: { id: number; name: string };
  /** Assigned user information (optional) */
  assigned_to?: { id: number; name: string };
  /** Project information */
  project: { id: number; name: string };
}

/**
 * Execute the list_issues tool.
 * @param params - Tool parameters including optional filters
 * @param context - Execution context with Redmine client
 * @param context.redmine - Redmine service bridge instance
 * @param context.redmine.listIssues - Function to list issues
 * @returns Promise resolving to array of issues with total count or error
 */
export async function execute(
  params: Record<string, unknown>,
  context: { redmine: { listIssues: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; issues?: Issue[]; total_count?: number; error?: string }> {
  try {
    const result = await context.redmine.listIssues(params);
    const data = result as { issues?: Issue[]; total_count?: number };

    return {
      success: true,
      issues: data.issues || [],
      total_count: data.total_count,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
