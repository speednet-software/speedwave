/**
 * Redmine: Get Mappings
 *
 * Get Redmine ID mappings (status, priority, tracker, activity types).
 * Useful for understanding valid values for other Redmine operations.
 * @returns {object} Mappings for status, priority, tracker, activity
 * @example
 * // Get all mappings
 * const mappings = await redmine.getMappings();
 * console.log(mappings.statuses); // [{id: 1, name: "New"}, ...]
 * console.log(mappings.priorities); // [{id: 1, name: "Low"}, ...]
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'getMappings',
  category: 'read',
  service: 'redmine',
  description: 'Get Redmine ID mappings (status, priority, tracker, activity types)',
  keywords: ['redmine', 'mappings', 'config', 'status', 'priority', 'tracker', 'activity'],
  inputSchema: {
    type: 'object',
    properties: {},
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      statuses: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'number' }, name: { type: 'string' } },
        },
      },
      priorities: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'number' }, name: { type: 'string' } },
        },
      },
      trackers: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'number' }, name: { type: 'string' } },
        },
      },
      activities: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'number' }, name: { type: 'string' } },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const mappings = await redmine.getMappings()`,
  inputExamples: [
    {
      description: 'Get all Redmine mappings (no params)',
      input: {},
    },
  ],
  deferLoading: true,
};

/**
 * Redmine configuration mappings for various entity types.
 * @interface Mappings
 */
interface Mappings {
  /** Available issue statuses */
  statuses: Array<{ id: number; name: string }>;
  /** Available priority levels */
  priorities: Array<{ id: number; name: string }>;
  /** Available issue trackers */
  trackers: Array<{ id: number; name: string }>;
  /** Available time entry activities */
  activities: Array<{ id: number; name: string }>;
}

/**
 * Execute the get_mappings tool.
 * @param params - Tool parameters (none required)
 * @param context - Execution context with Redmine client
 * @param context.redmine - Redmine service bridge instance
 * @param context.redmine.getMappings - Function to get field mappings
 * @returns Promise resolving to configuration mappings or error
 */
export async function execute(
  params: Record<string, unknown>,
  context: { redmine: { getMappings: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; mappings?: Mappings; error?: string }> {
  try {
    const result = await context.redmine.getMappings({});

    return {
      success: true,
      mappings: result as Mappings,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
