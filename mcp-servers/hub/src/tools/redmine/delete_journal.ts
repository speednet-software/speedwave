/**
 * Redmine: Delete Journal
 *
 * Delete a journal entry (removes comment from issue history).
 * @param {number} issue_id - Issue ID
 * @param {number} journal_id - Journal entry ID to delete
 * @returns {object} Success status
 * @example
 * // Delete a comment
 * await redmine.deleteJournal({
 *   issue_id: 12345,
 *   journal_id: 67890
 * });
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'deleteJournal',
  category: 'delete',
  service: 'redmine',
  description: 'Delete a journal entry (removes comment from issue history)',
  keywords: ['redmine', 'journal', 'delete', 'remove', 'comment'],
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'number', description: 'Issue ID' },
      journal_id: { type: 'number', description: 'Journal entry ID to delete' },
    },
    required: ['issue_id', 'journal_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      deleted_journal_id: { type: 'number' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `await redmine.deleteJournal({ issue_id: 12345, journal_id: 67890 })`,
  inputExamples: [
    {
      description: 'Minimal: delete a journal entry',
      input: { issue_id: 12345, journal_id: 67890 },
    },
    {
      description: 'Full: remove comment from history',
      input: { issue_id: 67890, journal_id: 54321 },
    },
  ],
  deferLoading: true,
};

/**
 * Execute the delete_journal tool.
 * @param params - Tool parameters including issue_id and journal_id
 * @param params.issue_id - Redmine issue ID
 * @param params.journal_id - Journal entry ID
 * @param context - Execution context with Redmine client
 * @param context.redmine - Redmine service bridge instance
 * @param context.redmine.deleteJournal - Function to delete journal entries
 * @returns Promise resolving to success status or error
 */
export async function execute(
  params: { issue_id: number; journal_id: number },
  context: { redmine: { deleteJournal: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; error?: string }> {
  const { issue_id, journal_id } = params;

  if (!issue_id || !journal_id) {
    return {
      success: false,
      error: 'Missing required fields: issue_id, journal_id',
    };
  }

  try {
    await context.redmine.deleteJournal(params);

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
