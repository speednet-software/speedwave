/**
 * Redmine: Comment Issue
 *
 * Add a comment/note to an issue.
 * @param {number} issue_id - Issue ID
 * @param {string} notes - Comment text (Textile markup supported)
 * @returns {object} Success status
 * @example
 * // Add a comment
 * await redmine.commentIssue({
 *   issue_id: 12345,
 *   notes: "Fixed in commit abc123. Ready for review."
 * });
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'commentIssue',
  category: 'write',
  service: 'redmine',
  description: 'Add a comment/note to an issue',
  keywords: ['redmine', 'issue', 'comment', 'note', 'add'],
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'number', description: 'Issue ID' },
      notes: { type: 'string', description: 'Comment text (Textile markup)' },
    },
    required: ['issue_id', 'notes'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      journal_id: { type: 'number', description: 'ID of created journal entry' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `await redmine.commentIssue({ issue_id: 12345, notes: "Work in progress" })`,
  inputExamples: [
    {
      description: 'Simple comment',
      input: { issue_id: 12345, notes: 'Work in progress' },
    },
    {
      description: 'Detailed comment with Textile',
      input: {
        issue_id: 12345,
        notes: 'h3. Update\n\n* Completed code review\n* Tests passing\n* Ready for merge',
      },
    },
  ],
  deferLoading: true,
};

/**
 * Execute the comment_issue tool.
 * @param params - Tool parameters including issue_id and comment text
 * @param params.issue_id - Redmine issue ID
 * @param params.notes - Comment text to add
 * @param context - Execution context with Redmine client
 * @param context.redmine - Redmine service bridge instance
 * @param context.redmine.commentIssue - Function to add comments to issues
 * @returns Promise resolving to success status or error
 */
export async function execute(
  params: { issue_id: number; notes: string },
  context: { redmine: { commentIssue: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; error?: string }> {
  const { issue_id, notes } = params;

  if (!issue_id || !notes) {
    return {
      success: false,
      error: 'Missing required fields: issue_id, notes',
    };
  }

  try {
    await context.redmine.commentIssue(params);

    return {
      success: true,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
