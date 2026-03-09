/**
 * Redmine: Update Issue
 *
 * Update an existing issue (status, assignee, description, project, etc.).
 * @param {number} issue_id - Issue ID to update
 * @param {string} [project_id] - Move issue to another project (project identifier)
 * @param {string} [subject] - New issue title
 * @param {string} [status] - New status name or ID
 * @param {string} [assigned_to] - New assignee (user identifier)
 * @param {number} [parent_id] - Parent issue ID (set to make subtask, set to null to remove)
 * @param {string} [notes] - Update notes/comment (added to journal)
 * @returns {object} Updated issue
 * @example
 * // Change status to in_progress
 * const updated = await redmine.updateIssue({
 *   issue_id: 12345,
 *   status: "in_progress"
 * });
 *
 * // Move issue to another project
 * await redmine.updateIssue({
 *   issue_id: 12345,
 *   project_id: "app"
 * });
 *
 * // Add note and assign to user
 * await redmine.updateIssue({
 *   issue_id: 12345,
 *   assigned_to: "alice",
 *   notes: "Assigned for review"
 * });
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'updateIssue',
  category: 'write',
  service: 'redmine',
  description: 'Update an existing issue (status, assignee, description, project, etc.)',
  keywords: ['redmine', 'issue', 'update', 'modify', 'change', 'edit', 'move', 'project'],
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'number', description: 'Issue ID to update' },
      project_id: {
        type: 'string',
        description: 'Move issue to another project (project identifier)',
      },
      subject: { type: 'string', description: 'New issue title' },
      description: { type: 'string', description: 'New issue description (Textile markup)' },
      status: { type: 'string', description: 'New status name or ID' },
      assigned_to: { type: 'string', description: 'New assignee' },
      parent_id: {
        type: 'number',
        description: 'Parent issue ID (set to make subtask, set to null to remove)',
      },
      notes: { type: 'string', description: 'Update notes/comment' },
    },
    required: ['issue_id'],
  },
  outputSchema: {
    type: 'object',
    description:
      'Returns the updated issue - ALWAYS verify assigned_to/status match your request (Redmine may silently ignore changes for closed issues)',
    properties: {
      id: { type: 'number', description: 'Issue ID' },
      subject: { type: 'string', description: 'Issue subject' },
      status: {
        type: 'object',
        properties: { id: { type: 'number' }, name: { type: 'string' } },
      },
      assigned_to: {
        type: 'object',
        description: 'Assigned user (null if Redmine rejected assignment)',
        properties: { id: { type: 'number' }, name: { type: 'string' } },
      },
      project: {
        type: 'object',
        properties: { id: { type: 'number' }, name: { type: 'string' } },
      },
    },
  },
  example: `const updated = await redmine.updateIssue({ issue_id: 12345, assigned_to_id: userId });
// IMPORTANT: Verify change was applied - Redmine silently ignores some changes for closed issues
if (!updated.assigned_to || updated.assigned_to.id !== userId) {
  throw new Error("Assignment failed - issue status may block this change");
}`,
  inputExamples: [
    {
      description: 'Minimal: close issue',
      input: { issue_id: 12345, status: 'closed' },
    },
    {
      description: 'Move to another project',
      input: { issue_id: 12345, project_id: 'app' },
    },
    {
      description: 'Make subtask of parent issue',
      input: { issue_id: 12345, parent_id: 81377 },
    },
    {
      description: 'Partial: reassign with note',
      input: {
        issue_id: 12345,
        assigned_to: 'john@example.com',
        notes: 'Reassigning for code review',
      },
    },
    {
      description: 'Full: update multiple fields',
      input: {
        issue_id: 12345,
        subject: 'Updated title',
        status: 'in_progress',
        assigned_to: 'me',
        notes: 'Starting work on this issue',
      },
    },
  ],
  deferLoading: true,
};

/**
 * Execute the update_issue tool.
 * @param params - Tool parameters including issue_id and fields to update
 * @param params.issue_id - Redmine issue ID
 * @param context - Execution context with Redmine client
 * @param context.redmine - Redmine service bridge instance
 * @param context.redmine.updateIssue - Function to update issues
 * @returns Promise resolving to success status or error
 */
export async function execute(
  params: { issue_id: number; [key: string]: unknown },
  context: { redmine: { updateIssue: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; error?: string }> {
  const { issue_id } = params;

  if (!issue_id) {
    return {
      success: false,
      error: 'Missing required field: issue_id',
    };
  }

  try {
    await context.redmine.updateIssue(params);

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
