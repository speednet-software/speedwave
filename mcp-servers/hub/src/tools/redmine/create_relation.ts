/**
 * Redmine: Create Relation
 *
 * Create a relation between two issues.
 * Supports: relates, duplicates, duplicated, blocks, blocked, precedes, follows, copied_to, copied_from.
 * @param {number} issue_id - Source issue ID
 * @param {number} issue_to_id - Target issue ID
 * @param {string} [relation_type='relates'] - Type of relation
 * @param {number} [delay] - Delay in days (for precedes/follows)
 * @returns {object} Created relation object
 * @example
 * // Create a blocking relation
 * await redmine.createRelation({
 *   issue_id: 100,
 *   issue_to_id: 101,
 *   relation_type: 'blocks'
 * });
 */

import { ToolMetadata } from '../../hub-types.js';
import { REDMINE_RELATION_TYPES, IssueRelation, isValidRelationType } from './types.js';
import { ts } from '@speedwave/mcp-shared';

export const metadata: ToolMetadata = {
  name: 'createRelation',
  category: 'write',
  service: 'redmine',
  description:
    'Create a relation between two issues (relates, duplicates, blocks, precedes, follows, etc.)',
  keywords: ['redmine', 'relation', 'create', 'link', 'dependency', 'blocks', 'precedes'],
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'number', description: 'Source issue ID' },
      issue_to_id: { type: 'number', description: 'Target issue ID' },
      relation_type: {
        type: 'string',
        enum: [...REDMINE_RELATION_TYPES],
        description: 'Type of relation (default: relates)',
      },
      delay: { type: 'number', description: 'Delay in days (for precedes/follows)' },
    },
    required: ['issue_id', 'issue_to_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      relation: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Relation ID' },
          issue_id: { type: 'number', description: 'Source issue ID' },
          issue_to_id: { type: 'number', description: 'Target issue ID' },
          relation_type: {
            type: 'string',
            enum: [...REDMINE_RELATION_TYPES],
            description: 'Type of relation',
          },
          delay: { type: 'number', description: 'Delay in days' },
        },
        description: 'Created relation',
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `await redmine.createRelation({ issue_id: 100, issue_to_id: 101, relation_type: 'blocks' })`,
  inputExamples: [
    {
      description: 'Simple relation (default: relates)',
      input: { issue_id: 100, issue_to_id: 101 },
    },
    {
      description: 'Blocking relation',
      input: { issue_id: 100, issue_to_id: 101, relation_type: 'blocks' },
    },
    {
      description: 'Sequence with delay',
      input: { issue_id: 100, issue_to_id: 101, relation_type: 'precedes', delay: 2 },
    },
  ],
  deferLoading: true,
};

/**
 * Execute the create_relation tool.
 * @param params - Tool parameters
 * @param params.issue_id - Source issue ID
 * @param params.issue_to_id - Target issue ID
 * @param params.relation_type - Type of relation
 * @param params.delay - Delay in days (optional)
 * @param context - Execution context with Redmine client
 * @param context.redmine - Redmine service bridge instance
 * @param context.redmine.createRelation - Function to create relation between issues
 * @returns Promise resolving to created relation or error
 */
export async function execute(
  params: { issue_id: number; issue_to_id: number; relation_type?: string; delay?: number },
  context: {
    redmine: {
      createRelation: (p: Record<string, unknown>) => Promise<{ relation: IssueRelation }>;
    };
  }
): Promise<{ success: boolean; relation?: IssueRelation; error?: string }> {
  const { issue_id, issue_to_id, relation_type, delay } = params;

  // Validate required fields
  if (!issue_id || !issue_to_id) {
    return {
      success: false,
      error: 'Missing required fields: issue_id, issue_to_id',
    };
  }

  // Validate relation_type if provided (empty string is invalid)
  if (relation_type !== undefined && relation_type !== null) {
    if (relation_type === '' || !isValidRelationType(relation_type)) {
      return {
        success: false,
        error: `Invalid relation_type "${relation_type}". Valid types: ${REDMINE_RELATION_TYPES.join(', ')}`,
      };
    }
  }

  // Validate delay is only used with precedes/follows
  if (delay !== undefined && relation_type && !['precedes', 'follows'].includes(relation_type)) {
    console.warn(
      `${ts()} [createRelation] delay parameter is only meaningful for precedes/follows relations, ` +
        `but relation_type is "${relation_type}". Delay will be ignored by Redmine.`
    );
  }

  try {
    const result = await context.redmine.createRelation({
      issue_id,
      issue_to_id,
      relation_type,
      delay,
    });

    return {
      success: true,
      relation: result.relation,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(
      `${ts()} [createRelation] Failed to create relation from issue #${issue_id} to #${issue_to_id}:`,
      {
        params: { issue_id, issue_to_id, relation_type, delay },
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      }
    );

    return {
      success: false,
      error: `Failed to create relation from #${issue_id} to #${issue_to_id}: ${errorMessage}`,
    };
  }
}
