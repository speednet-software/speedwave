/**
 * Redmine: Update Journal
 *
 * Update a journal entry (note/comment).
 * @param {number} issue_id - Issue ID
 * @param {number} journal_id - Journal entry ID
 * @param {string} notes - New note text
 * @returns {object} Success status
 * @example
 * // Update a comment
 * await redmine.updateJournal({
 *   issue_id: 12345,
 *   journal_id: 67890,
 *   notes: "Updated comment with more details"
 * });
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'updateJournal',
  category: 'write',
  service: 'redmine',
  description: 'Update a journal entry (note/comment)',
  keywords: ['redmine', 'journal', 'update', 'comment', 'edit', 'modify'],
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'number', description: 'Issue ID' },
      journal_id: { type: 'number', description: 'Journal entry ID' },
      notes: { type: 'string', description: 'New note text' },
    },
    required: ['issue_id', 'journal_id', 'notes'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      journal: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          notes: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `await redmine.updateJournal({ issue_id: 12345, journal_id: 67890, notes: "Updated comment with more details" })`,
  inputExamples: [
    {
      description: 'Minimal: update journal note',
      input: { issue_id: 12345, journal_id: 67890, notes: 'Updated comment with more details' },
    },
    {
      description: 'Full: update with detailed note',
      input: {
        issue_id: 12345,
        journal_id: 67890,
        notes: 'h3. Correction\n\nPrevious analysis was incorrect. Updated with new findings.',
      },
    },
  ],
  deferLoading: true,
};

/**
 * Execute the update_journal tool.
 * @param params - Tool parameters including issue_id, journal_id, and new notes
 * @param params.issue_id - Redmine issue ID
 * @param params.journal_id - Journal entry ID
 * @param params.notes - Journal entry notes text
 * @param context - Execution context with Redmine client
 * @param context.redmine - Redmine service bridge instance
 * @param context.redmine.updateJournal - Function to update journal entries
 * @returns Promise resolving to success status or error
 */
export async function execute(
  params: { issue_id: number; journal_id: number; notes: string },
  context: { redmine: { updateJournal: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; error?: string }> {
  const { issue_id, journal_id, notes } = params;

  if (!issue_id || !journal_id || !notes) {
    return {
      success: false,
      error: 'Missing required fields: issue_id, journal_id, notes',
    };
  }

  try {
    await context.redmine.updateJournal(params);

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
