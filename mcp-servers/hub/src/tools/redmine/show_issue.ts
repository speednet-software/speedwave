/**
 * Redmine: Show Issue
 *
 * Get detailed information about a specific issue.
 * Includes description, journals (history), and attachments.
 * @param {number} issue_id - Issue ID (numeric)
 * @param {string[]} [include] - Data to include: journals, attachments, relations, children, watchers
 * @returns {object} Detailed issue information
 * @example
 * // Get issue details
 * const issue = await redmine.getIssueFull({ issue_id: 12345 });
 *
 * // Get issue with journals and attachments
 * const issueWithHistory = await redmine.getIssueFull({
 *   issue_id: 12345,
 *   include: ["journals", "attachments"]
 * });
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'getIssueFull',
  category: 'read',
  service: 'redmine',
  description:
    'Get full details about a specific issue including custom fields, journals and attachments',
  keywords: ['redmine', 'issue', 'show', 'get', 'detail', 'single', 'full'],
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'number', description: 'Issue ID (numeric)' },
      include: {
        type: 'array',
        items: { type: 'string' },
        description: 'Data to include: journals, attachments, relations, children, watchers',
      },
    },
    required: ['issue_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      issue: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          subject: { type: 'string' },
          description: { type: 'string' },
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
          created_on: { type: 'string', description: 'ISO 8601 timestamp' },
          updated_on: { type: 'string', description: 'ISO 8601 timestamp' },
          journals: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'number' },
                user: {
                  type: 'object',
                  properties: { id: { type: 'number' }, name: { type: 'string' } },
                },
                notes: { type: 'string' },
                created_on: { type: 'string' },
              },
            },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const issue = await redmine.getIssueFull({ issue_id: 12345, include: ["journals", "attachments"] })`,
  inputExamples: [
    {
      description: 'Minimal: get basic issue details',
      input: { issue_id: 12345 },
    },
    {
      description: 'Full: get issue with journals, attachments and relations',
      input: { issue_id: 12345, include: ['journals', 'attachments', 'relations'] },
    },
  ],
  deferLoading: false,
};

/**
 * Detailed issue information from Redmine.
 * @interface IssueDetail
 */
interface IssueDetail {
  /** Issue ID */
  id: number;
  /** Issue subject/title */
  subject: string;
  /** Issue description in Textile markup */
  description: string;
  /** Issue status information */
  status: { id: number; name: string };
  /** Issue priority information */
  priority: { id: number; name: string };
  /** Assigned user information (optional) */
  assigned_to?: { id: number; name: string };
  /** Project information */
  project: { id: number; name: string };
  /** Creation timestamp */
  created_on: string;
  /** Last update timestamp */
  updated_on: string;
  /** Journal entries (history) if requested */
  journals?: Array<{
    /** Journal entry ID */
    id: number;
    /** User who created the entry */
    user: { id: number; name: string };
    /** Journal notes/comment */
    notes: string;
    /** Entry creation timestamp */
    created_on: string;
  }>;
}

/**
 * Execute the show_issue tool.
 * @param params - Tool parameters including issue_id and optional include array
 * @param params.issue_id - Redmine issue ID
 * @param params.include - Array of data to include (journals, attachments, relations, children, watchers)
 * @param context - Execution context with Redmine client
 * @param context.redmine - Redmine service bridge instance
 * @param context.redmine.showIssue - Function to show issue details
 * @returns Promise resolving to detailed issue information or error
 */
export async function execute(
  params: { issue_id: number; include?: string[] },
  context: { redmine: { showIssue: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; issue?: IssueDetail; error?: string }> {
  const { issue_id } = params;

  if (!issue_id) {
    return {
      success: false,
      error: 'Missing required field: issue_id',
    };
  }

  try {
    const result = await context.redmine.showIssue(params);

    return {
      success: true,
      issue: result as IssueDetail,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
