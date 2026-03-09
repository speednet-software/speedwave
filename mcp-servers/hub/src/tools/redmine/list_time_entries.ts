/**
 * Redmine: List Time Entries
 *
 * List time entries with optional filters (issue, user, date range).
 * @param {number} [issue_id] - Filter by issue ID
 * @param {number} [user_id] - Filter by user ID
 * @param {string} [from] - Start date (YYYY-MM-DD)
 * @param {string} [to] - End date (YYYY-MM-DD)
 * @param {number} [limit=25] - Maximum entries
 * @returns {object} Array of time entries
 * @example
 * // List my time entries for this week
 * const entries = await redmine.listTimeEntries({
 *   user_id: 42,
 *   from: "2024-01-20",
 *   to: "2024-01-26"
 * });
 *
 * // List time entries for an issue
 * const issueTime = await redmine.listTimeEntries({
 *   issue_id: 12345
 * });
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'listTimeEntries',
  category: 'read',
  service: 'redmine',
  description: 'List time entries with optional filters (issue, user, date range)',
  keywords: ['redmine', 'time', 'entries', 'list', 'hours', 'log'],
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'number', description: 'Filter by issue ID' },
      user_id: { type: 'number', description: 'Filter by user ID' },
      from: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
      to: { type: 'string', description: 'End date (YYYY-MM-DD)' },
      limit: { type: 'number', description: 'Maximum entries (default: 25)' },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      time_entries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            hours: { type: 'number' },
            activity: {
              type: 'object',
              properties: { id: { type: 'number' }, name: { type: 'string' } },
            },
            comments: { type: 'string' },
            spent_on: { type: 'string', description: 'Date in YYYY-MM-DD format' },
            user: {
              type: 'object',
              properties: { id: { type: 'number' }, name: { type: 'string' } },
            },
            issue: { type: 'object', properties: { id: { type: 'number' } } },
          },
        },
      },
      total_count: { type: 'number' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const entries = await redmine.listTimeEntries({ issue_id: 12345 })`,
  inputExamples: [
    {
      description: 'Minimal: list all entries',
      input: {},
    },
    {
      description: 'Partial: entries for issue',
      input: { issue_id: 12345 },
    },
    {
      description: 'Full: date range with limit',
      input: { from: '2024-01-01', to: '2024-01-31', user_id: 42, limit: 100 },
    },
  ],
  deferLoading: true,
};

/**
 * Time entry from Redmine.
 * @interface TimeEntry
 */
interface TimeEntry {
  /** Time entry ID */
  id: number;
  /** Hours spent */
  hours: number;
  /** Activity type */
  activity: { id: number; name: string };
  /** Comments about work done */
  comments?: string;
  /** Date spent (YYYY-MM-DD) */
  spent_on: string;
  /** User who logged time */
  user: { id: number; name: string };
  /** Issue the time was logged against */
  issue: { id: number };
}

/**
 * Execute the list_time_entries tool.
 * @param params - Tool parameters including optional filters
 * @param context - Execution context with Redmine client
 * @param context.redmine - Redmine service bridge instance
 * @param context.redmine.listTimeEntries - Function to list time entries
 * @returns Promise resolving to array of time entries or error
 */
export async function execute(
  params: Record<string, unknown>,
  context: { redmine: { listTimeEntries: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; time_entries?: TimeEntry[]; total_count?: number; error?: string }> {
  try {
    const result = await context.redmine.listTimeEntries(params);
    const data = result as { time_entries?: TimeEntry[]; total_count?: number };

    return {
      success: true,
      time_entries: data.time_entries || [],
      total_count: data.total_count,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
