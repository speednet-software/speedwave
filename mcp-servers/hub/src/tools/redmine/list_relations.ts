/**
 * Redmine: List Relations
 *
 * List all relations for a specific issue.
 * Returns relation type (blocks, precedes, duplicates, etc.), target issue, and delay.
 * @param {number} issue_id - Issue ID
 * @returns {object} Object with relations array
 * @example
 * // Get all relations for an issue
 * const { relations } = await redmine.listRelations({ issue_id: 12345 });
 * // Returns: { relations: [{ id, issue_id, issue_to_id, relation_type, delay? }] }
 */

import { ToolMetadata } from '../../hub-types.js';
import { REDMINE_RELATION_TYPES, IssueRelation } from './types.js';
import { ts } from '../../../../shared/dist/index.js';

// Re-export types for backward compatibility
export { RelationType, IssueRelation } from './types.js';

export const metadata: ToolMetadata = {
  name: 'listRelations',
  category: 'read',
  service: 'redmine',
  description:
    'List all relations for an issue (blocks, precedes, duplicates, relates, follows, etc.)',
  keywords: ['redmine', 'relation', 'link', 'dependency', 'blocks', 'precedes', 'follows', 'list'],
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
      relations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Relation ID' },
            issue_id: { type: 'number', description: 'Source issue ID' },
            issue_to_id: { type: 'number', description: 'Target issue ID' },
            relation_type: {
              type: 'string',
              enum: [...REDMINE_RELATION_TYPES],
              description: 'Type: relates, duplicates, blocks, precedes, follows, etc.',
            },
            delay: { type: 'number', description: 'Delay in days (for precedes/follows)' },
          },
        },
        description: 'List of relations',
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const { relations } = await redmine.listRelations({ issue_id: 12345 })`,
  inputExamples: [
    {
      description: 'Get all relations for an issue',
      input: { issue_id: 12345 },
    },
  ],
  deferLoading: true,
};

/**
 * Execute the list_relations tool.
 * @param params - Tool parameters including issue_id
 * @param params.issue_id - Redmine issue ID
 * @param context - Execution context with Redmine client
 * @param context.redmine - Redmine service bridge instance
 * @param context.redmine.listRelations - Function to list relations for an issue
 * @returns Promise resolving to relations array or error
 */
export async function execute(
  params: { issue_id: number },
  context: {
    redmine: {
      listRelations: (p: Record<string, unknown>) => Promise<{ relations: IssueRelation[] }>;
    };
  }
): Promise<{ success: boolean; relations?: IssueRelation[]; error?: string }> {
  const { issue_id } = params;

  if (!issue_id) {
    return {
      success: false,
      error: 'Missing required field: issue_id',
    };
  }

  try {
    const result = await context.redmine.listRelations({ issue_id });

    return {
      success: true,
      relations: result.relations,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${ts()} [listRelations] Failed to list relations for issue #${issue_id}:`, {
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
    });

    return {
      success: false,
      error: `Failed to list relations for issue #${issue_id}: ${errorMessage}`,
    };
  }
}
