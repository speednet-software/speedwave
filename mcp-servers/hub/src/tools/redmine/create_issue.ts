/**
 * Redmine: Create Issue
 *
 * Create a new issue or subtask in Redmine.
 * @param {string} subject - Issue title/subject (required)
 * @param {string} project_id - Project ID or identifier (required)
 * @param {string} [description] - Issue description (Textile markup supported)
 * @param {string} [tracker] - Tracker name (bug, feature, task) or ID
 * @param {string} [priority] - Priority name (low, normal, high) or ID
 * @param {string} [assigned_to] - User identifier (me, ID, name, email)
 * @param {number} [parent_id] - Parent issue ID (creates subtask)
 * @returns {object} Created issue with ID
 * @example
 * // Create a bug report
 * const issue = await redmine.createIssue({
 *   subject: "Login fails with special characters",
 *   project_id: "speedwave-core",
 *   tracker: "bug",
 *   priority: "high"
 * });
 *
 * // Create a subtask
 * const subtask = await redmine.createIssue({
 *   subject: "Implement unit tests",
 *   project_id: "speedwave-core",
 *   parent_id: 12345
 * });
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'createIssue',
  category: 'write',
  service: 'redmine',
  description: 'Create a new issue or subtask in Redmine',
  keywords: ['redmine', 'issue', 'create', 'new', 'task', 'bug', 'add'],
  inputSchema: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'Issue title/subject' },
      project_id: { type: 'string', description: 'Project ID or identifier' },
      description: { type: 'string', description: 'Issue description (Textile markup)' },
      tracker: { type: 'string', description: 'Tracker name (bug, feature, task) or ID' },
      priority: { type: 'string', description: 'Priority name (low, normal, high) or ID' },
      assigned_to: { type: 'string', description: 'User identifier' },
      parent_id: { type: 'number', description: 'Parent issue ID (creates subtask)' },
    },
    required: ['subject', 'project_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      issue: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'ID of created issue' },
          subject: { type: 'string' },
          project: {
            type: 'object',
            properties: { id: { type: 'number' }, name: { type: 'string' } },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const issue = await redmine.createIssue({ subject: "Fix bug", project_id: "my-project", tracker: "bug" })`,
  inputExamples: [
    {
      description: 'Minimal: create with required fields only',
      input: { subject: 'Fix login bug', project_id: 'my-project' },
    },
    {
      description: 'Partial: bug with priority',
      input: {
        subject: 'Users cannot reset password',
        project_id: 'my-project',
        tracker: 'bug',
        priority: 'high',
        assigned_to: 'me',
      },
    },
    {
      description: 'Full: create subtask with all fields',
      input: {
        subject: 'Implement JWT validation',
        project_id: 'my-project',
        description:
          'h2. Context\n\nToken expiry not validated.\n\nh2. Acceptance Criteria\n\n* Validate token on each request',
        tracker: 'task',
        priority: 'normal',
        assigned_to: 'jane.doe',
        parent_id: 12345,
      },
    },
  ],
  deferLoading: false,
};

/**
 * Created issue information from Redmine.
 * @interface CreatedIssue
 */
interface CreatedIssue {
  /** Newly created issue ID */
  id: number;
  /** Issue subject/title */
  subject: string;
  /** Project information */
  project: { id: number; name: string };
}

/**
 * Execute the create_issue tool.
 * @param params - Tool parameters including subject, project_id, and optional fields
 * @param params.subject - Time entry subject/description
 * @param params.project_id - Project ID or path
 * @param context - Execution context with Redmine client
 * @param context.redmine - Redmine service bridge instance
 * @param context.redmine.createIssue - Function to create issues
 * @returns Promise resolving to created issue information or error
 */
export async function execute(
  params: { subject: string; project_id: string; [key: string]: unknown },
  context: { redmine: { createIssue: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; issue?: CreatedIssue; error?: string }> {
  const { subject, project_id } = params;

  if (!subject || !project_id) {
    return {
      success: false,
      error: 'Missing required fields: subject, project_id',
    };
  }

  try {
    const result = await context.redmine.createIssue(params);

    return {
      success: true,
      issue: result as CreatedIssue,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
