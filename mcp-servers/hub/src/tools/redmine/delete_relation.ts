/**
 * Redmine: Delete Relation
 *
 * Delete a relation between issues.
 * @param {number} relation_id - Relation ID to delete
 * @returns {object} Success status
 * @example
 * // Delete a relation
 * await redmine.deleteRelation({ relation_id: 456 });
 */

import { ToolMetadata } from '../../hub-types.js';
import { ts } from '@speedwave/mcp-shared';

export const metadata: ToolMetadata = {
  name: 'deleteRelation',
  category: 'delete',
  service: 'redmine',
  description: 'Delete a relation between issues',
  keywords: ['redmine', 'relation', 'delete', 'remove', 'unlink'],
  inputSchema: {
    type: 'object',
    properties: {
      relation_id: { type: 'number', description: 'Relation ID to delete' },
    },
    required: ['relation_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      message: { type: 'string', description: 'Success message' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `await redmine.deleteRelation({ relation_id: 456 })`,
  inputExamples: [
    {
      description: 'Delete a relation by ID',
      input: { relation_id: 456 },
    },
  ],
  deferLoading: true,
};

/**
 * Execute the delete_relation tool.
 * @param params - Tool parameters
 * @param params.relation_id - Relation ID to delete
 * @param context - Execution context with Redmine client
 * @param context.redmine - Redmine service bridge instance
 * @param context.redmine.deleteRelation - Function to delete a relation
 * @returns Promise resolving to success status or error
 */
export async function execute(
  params: { relation_id: number },
  context: { redmine: { deleteRelation: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; message?: string; error?: string }> {
  const { relation_id } = params;

  if (!relation_id) {
    return {
      success: false,
      error: 'Missing required field: relation_id',
    };
  }

  try {
    await context.redmine.deleteRelation({ relation_id });

    return {
      success: true,
      message: `Relation ${relation_id} deleted successfully`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${ts()} [deleteRelation] Failed to delete relation ${relation_id}:`, {
      relation_id,
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
    });

    return {
      success: false,
      error: `Failed to delete relation ${relation_id}: ${errorMessage}`,
    };
  }
}
