/**
 * Discussion Tools - 2 tools for GitLab MR discussions
 */

import { Tool, ToolDefinition, jsonResult, errorResult } from '@speedwave/mcp-shared';
import { GitLabClient } from '../client.js';
import { withValidation } from './validation.js';

const listMrDiscussionsTool: Tool = {
  name: 'listMrDiscussions',
  description: 'List discussion threads on a merge request',
  category: 'read',
  keywords: ['gitlab', 'merge', 'request', 'discussions', 'threads'],
  example:
    'const discussions = await gitlab.listMrDiscussions({ project_id: "speedwave/core", mr_iid: 42 })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      mr_iid: { type: 'number', description: 'Merge request IID' },
      limit: { type: 'number', description: 'Max results (default 20)' },
    },
    required: ['project_id', 'mr_iid'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      discussions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            notes: { type: 'array' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'List MR discussions',
      input: { project_id: 'my-group/my-project', mr_iid: 123 },
    },
  ],
};

const createMrDiscussionTool: Tool = {
  name: 'createMrDiscussion',
  description: 'Create a discussion thread on a merge request',
  category: 'write',
  keywords: ['gitlab', 'merge', 'request', 'discussion', 'thread'],
  example:
    'await gitlab.createMrDiscussion({ project_id: "speedwave/core", mr_iid: 42, body: "What about error handling?" })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      mr_iid: { type: 'number', description: 'Merge request IID' },
      body: { type: 'string', description: 'Discussion body' },
    },
    required: ['project_id', 'mr_iid', 'body'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      discussion: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          notes: { type: 'array' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Start discussion',
      input: {
        project_id: 'my-group/my-project',
        mr_iid: 123,
        body: 'Can we refactor this?',
      },
    },
  ],
};

/**
 * Tool handler function
 * @param client - GitLab client instance
 */
export function createDiscussionTools(client: GitLabClient | null): ToolDefinition[] {
  const unconfigured = async () =>
    errorResult('GitLab not configured. Run: speedwave setup gitlab');
  if (!client) {
    return [
      { tool: listMrDiscussionsTool, handler: unconfigured },
      { tool: createMrDiscussionTool, handler: unconfigured },
    ];
  }

  return [
    {
      tool: listMrDiscussionsTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, mr_iid, limit } = params as {
          project_id: string | number;
          mr_iid: number;
          limit?: number;
        };
        const result = await c.listMrDiscussions(project_id, mr_iid, limit);
        return jsonResult(result);
      }),
    },
    {
      tool: createMrDiscussionTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, mr_iid, body } = params as {
          project_id: string | number;
          mr_iid: number;
          body: string;
        };
        const result = await c.createMrDiscussion(project_id, mr_iid, body);
        return jsonResult(result);
      }),
    },
  ];
}
