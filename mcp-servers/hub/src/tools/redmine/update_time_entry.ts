/**
 * Redmine: Update Time Entry
 *
 * Update an existing time entry.
 * @param {number} time_entry_id - Time entry ID
 * @param {number} [hours] - New hours value
 * @param {string} [activity] - New activity type or ID
 * @param {string} [comments] - New comments
 * @returns {object} Success status
 * @example
 * // Update hours
 * await redmine.updateTimeEntry({
 *   time_entry_id: 789,
 *   hours: 3.5
 * });
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'updateTimeEntry',
  category: 'write',
  service: 'redmine',
  description: 'Update an existing time entry',
  keywords: ['redmine', 'time', 'update', 'modify', 'hours', 'edit'],
  inputSchema: {
    type: 'object',
    properties: {
      time_entry_id: { type: 'number', description: 'Time entry ID' },
      hours: { type: 'number', description: 'New hours value' },
      activity: { type: 'string', description: 'New activity type or ID' },
      comments: { type: 'string', description: 'New comments' },
    },
    required: ['time_entry_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      time_entry: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          hours: { type: 'number' },
          activity: { type: 'object', properties: { name: { type: 'string' } } },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `await redmine.updateTimeEntry({ time_entry_id: 789, hours: 3.5 })`,
  inputExamples: [
    {
      description: 'Minimal: update hours only',
      input: { time_entry_id: 789, hours: 3.5 },
    },
    {
      description: 'Partial: update activity and comments',
      input: { time_entry_id: 789, activity: 'testing', comments: 'Updated test description' },
    },
    {
      description: 'Full: update all fields',
      input: {
        time_entry_id: 789,
        hours: 4.0,
        activity: 'development',
        comments: 'Corrected hours and activity',
      },
    },
  ],
  deferLoading: true,
};

/**
 * Execute the update_time_entry tool.
 * @param params - Tool parameters including time_entry_id and fields to update
 * @param params.time_entry_id - Time entry ID
 * @param context - Execution context with Redmine client
 * @param context.redmine - Redmine service bridge instance
 * @param context.redmine.updateTimeEntry - Function to update time entries
 * @returns Promise resolving to success status or error
 */
export async function execute(
  params: { time_entry_id: number; [key: string]: unknown },
  context: { redmine: { updateTimeEntry: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; error?: string }> {
  const { time_entry_id } = params;

  if (!time_entry_id) {
    return {
      success: false,
      error: 'Missing required field: time_entry_id',
    };
  }

  try {
    await context.redmine.updateTimeEntry(params);

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
