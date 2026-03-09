/**
 * Redmine: Create Time Entry
 *
 * Log time against an issue or project.
 * @param {number} hours - Hours spent (decimal, e.g., 2.5)
 * @param {number} [issue_id] - Issue ID (required if no project_id)
 * @param {string} [project_id] - Project ID (required if no issue_id)
 * @param {string} [activity] - Activity type (development, testing)
 * @param {string} [comments] - Description of work done
 * @param {string} [spent_on] - Date spent (YYYY-MM-DD, default: today)
 * @returns {object} Created time entry
 * @example
 * // Log 2 hours of development on issue
 * await redmine.createTimeEntry({
 *   issue_id: 12345,
 *   hours: 2,
 *   activity: "development",
 *   comments: "Implemented authentication flow"
 * });
 *
 * // Log time on project
 * await redmine.createTimeEntry({
 *   project_id: "speedwave-core",
 *   hours: 1.5,
 *   activity: "meeting",
 *   comments: "Sprint planning"
 * });
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'createTimeEntry',
  category: 'write',
  service: 'redmine',
  description: 'Log time against an issue or project',
  keywords: ['redmine', 'time', 'entry', 'create', 'log', 'hours'],
  inputSchema: {
    type: 'object',
    properties: {
      hours: { type: 'number', description: 'Hours spent (decimal, e.g., 2.5)' },
      issue_id: { type: 'number', description: 'Issue ID (required if no project_id)' },
      project_id: { type: 'string', description: 'Project ID (required if no issue_id)' },
      activity: { type: 'string', description: 'Activity type (development, testing)' },
      comments: { type: 'string', description: 'Description of work done' },
      spent_on: { type: 'string', description: 'Date spent (YYYY-MM-DD, default: today)' },
    },
    required: ['hours'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      time_entry: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'ID of created time entry' },
          hours: { type: 'number' },
          activity: {
            type: 'object',
            properties: { id: { type: 'number' }, name: { type: 'string' } },
          },
          spent_on: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `await redmine.createTimeEntry({ hours: 2.5, issue_id: 12345, activity: "development", comments: "Code review" })`,
  inputExamples: [
    {
      description: 'Minimal: log hours to issue',
      input: { hours: 2.5, issue_id: 12345 },
    },
    {
      description: 'Partial: with activity and comment',
      input: {
        hours: 4.0,
        issue_id: 12345,
        activity: 'development',
        comments: 'Implemented feature X',
      },
    },
    {
      description: 'Full: log to specific date',
      input: {
        hours: 8.0,
        issue_id: 12345,
        activity: 'development',
        comments: 'Full day refactoring',
        spent_on: '2024-01-15',
      },
    },
  ],
  deferLoading: true,
};

/**
 * Time entry record from Redmine.
 * @interface TimeEntry
 */
interface TimeEntry {
  /** Unique time entry identifier */
  id: number;
  /** Hours logged (decimal) */
  hours: number;
  /** Activity type information */
  activity: { id: number; name: string };
  /** Date when time was spent (YYYY-MM-DD) */
  spent_on: string;
}

/**
 * Execute the create_time_entry tool.
 * @param params - Tool parameters including hours, issue_id or project_id
 * @param params.hours - Number of hours to log
 * @param params.issue_id - Redmine issue ID
 * @param params.project_id - Project ID or path
 * @param context - Execution context with Redmine client
 * @param context.redmine - Redmine service bridge instance
 * @param context.redmine.createTimeEntry - Function to create time entries
 * @returns Promise resolving to created time entry or error
 */
export async function execute(
  params: { hours: number; issue_id?: number; project_id?: string; [key: string]: unknown },
  context: { redmine: { createTimeEntry: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; entry?: TimeEntry; error?: string }> {
  const { hours, issue_id, project_id } = params;

  if (!hours) {
    return {
      success: false,
      error: 'Missing required field: hours',
    };
  }

  if (!issue_id && !project_id) {
    return {
      success: false,
      error: 'Either issue_id or project_id is required',
    };
  }

  try {
    const result = await context.redmine.createTimeEntry(params);

    return {
      success: true,
      entry: result as TimeEntry,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
