/**
 * Redmine: List Journals
 *
 * List all journal entries (history/comments) for an issue.
 * @param {number} issue_id - Issue ID
 * @returns {object} Array of journal entries with user and timestamps
 * @example
 * // Get issue history
 * const journals = await redmine.listJournals({
 *   issue_id: 12345
 * });
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'listJournals',
  category: 'read',
  service: 'redmine',
  description: 'List all journal entries (history/comments) for an issue',
  keywords: ['redmine', 'journals', 'history', 'comments', 'audit', 'changelog'],
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'number', description: 'Issue ID' },
    },
    required: ['issue_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
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
            details: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  property: { type: 'string' },
                  name: { type: 'string' },
                  old_value: { type: 'string' },
                  new_value: { type: 'string' },
                },
              },
            },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const journals = await redmine.listJournals({ issue_id: 12345 })`,
  inputExamples: [
    {
      description: 'Minimal: get all journals for issue',
      input: { issue_id: 12345 },
    },
    {
      description: 'Full: get journal history',
      input: { issue_id: 67890 },
    },
  ],
  deferLoading: true,
};

/**
 * Journal entry (history/comment) from Redmine.
 * @interface JournalEntry
 */
interface JournalEntry {
  /** Journal entry ID */
  id: number;
  /** User who created the entry */
  user: { id: number; name: string };
  /** Journal notes/comment text */
  notes: string;
  /** Entry creation timestamp */
  created_on: string;
  /** Change details (optional) */
  details?: Array<{
    property: string;
    name: string;
    old_value?: string;
    new_value?: string;
  }>;
}

/**
 * Execute the list_journals tool.
 * @param params - Tool parameters including issue_id
 * @param params.issue_id - Redmine issue ID
 * @param context - Execution context with Redmine client
 * @param context.redmine - Redmine service bridge instance
 * @param context.redmine.listJournals - Function to list issue journals
 * @returns Promise resolving to array of journal entries or error
 */
export async function execute(
  params: { issue_id: number },
  context: { redmine: { listJournals: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; journals?: JournalEntry[]; error?: string }> {
  const { issue_id } = params;

  if (!issue_id) {
    return {
      success: false,
      error: 'Missing required field: issue_id',
    };
  }

  try {
    const result = await context.redmine.listJournals(params);
    const data = result as { journals?: JournalEntry[] };

    return {
      success: true,
      journals: data.journals || [],
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
