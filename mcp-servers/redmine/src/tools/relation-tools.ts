/**
 * Relation Tools - 3 tools for Redmine issue relations
 */

import { Tool, ToolDefinition, jsonResult, errorResult } from '@speedwave/mcp-shared';
import { RedmineClient } from '../client.js';

const listRelationsTool: Tool = {
  name: 'listRelations',
  description: 'List all relations for an issue (blocks, precedes, duplicates, etc.)',
  category: 'read',
  keywords: ['redmine', 'relation', 'link', 'dependency', 'blocks', 'precedes', 'follows', 'list'],
  example: `const { relations } = await redmine.listRelations({ issue_id: 12345 })`,
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
              enum: [
                'relates',
                'duplicates',
                'duplicated',
                'blocks',
                'blocked',
                'precedes',
                'follows',
                'copied_to',
                'copied_from',
              ],
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
  inputExamples: [
    {
      description: 'Get all relations for an issue',
      input: { issue_id: 12345 },
    },
  ],
};

const createRelationTool: Tool = {
  name: 'createRelation',
  description: 'Create a relation between two issues',
  category: 'write',
  keywords: ['redmine', 'relation', 'create', 'link', 'dependency', 'blocks', 'precedes'],
  example: `await redmine.createRelation({ issue_id: 100, issue_to_id: 101, relation_type: 'blocks' })`,
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'number', description: 'Source issue ID' },
      issue_to_id: { type: 'number', description: 'Target issue ID' },
      relation_type: {
        type: 'string',
        enum: [
          'relates',
          'duplicates',
          'duplicated',
          'blocks',
          'blocked',
          'precedes',
          'follows',
          'copied_to',
          'copied_from',
        ],
        description: 'Type of relation (default: relates)',
      },
      delay: { type: 'number', description: 'Delay in days (only for precedes/follows)' },
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
            enum: [
              'relates',
              'duplicates',
              'duplicated',
              'blocks',
              'blocked',
              'precedes',
              'follows',
              'copied_to',
              'copied_from',
            ],
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
};

const deleteRelationTool: Tool = {
  name: 'deleteRelation',
  description: 'Delete a relation between issues',
  category: 'delete',
  keywords: ['redmine', 'relation', 'delete', 'remove', 'unlink'],
  example: `await redmine.deleteRelation({ relation_id: 456 })`,
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
  inputExamples: [
    {
      description: 'Delete a relation by ID',
      input: { relation_id: 456 },
    },
  ],
};

type RelationType =
  | 'relates'
  | 'duplicates'
  | 'duplicated'
  | 'blocks'
  | 'blocked'
  | 'precedes'
  | 'follows'
  | 'copied_to'
  | 'copied_from';

/**
 * Tool handler function
 * @param client - Redmine client instance
 */
export function createRelationTools(client: RedmineClient | null): ToolDefinition[] {
  const unconfigured = async () =>
    errorResult('Redmine not configured. Run: speedwave setup redmine');
  if (!client) {
    return [
      { tool: listRelationsTool, handler: unconfigured },
      { tool: createRelationTool, handler: unconfigured },
      { tool: deleteRelationTool, handler: unconfigured },
    ];
  }

  return [
    {
      tool: listRelationsTool,
      handler: async (params) => {
        try {
          const { issue_id } = params as { issue_id: number };
          const result = await client.listRelations(issue_id);
          return jsonResult(result);
        } catch (error) {
          return errorResult(RedmineClient.formatError(error));
        }
      },
    },
    {
      tool: createRelationTool,
      handler: async (params) => {
        try {
          const { issue_id, issue_to_id, relation_type, delay } = params as {
            issue_id: number;
            issue_to_id: number;
            relation_type?: RelationType;
            delay?: number;
          };
          const result = await client.createRelation({
            issue_id,
            issue_to_id,
            relation_type,
            delay,
          });
          return jsonResult(result);
        } catch (error) {
          return errorResult(RedmineClient.formatError(error));
        }
      },
    },
    {
      tool: deleteRelationTool,
      handler: async (params) => {
        try {
          const { relation_id } = params as { relation_id: number };
          await client.deleteRelation(relation_id);
          return jsonResult({ ok: true });
        } catch (error) {
          return errorResult(RedmineClient.formatError(error));
        }
      },
    },
  ];
}
