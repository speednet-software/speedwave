/**
 * MR Notes Tools - 4 tools for GitLab MR commits, pipelines, notes
 */

import { Tool, ToolDefinition, jsonResult, errorResult } from '@speedwave/mcp-shared';
import { GitLabClient } from '../client.js';
import { withValidation } from './validation.js';

const listMrCommitsTool: Tool = {
  name: 'listMrCommits',
  description: 'List commits in a merge request',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      mr_iid: { type: 'number', description: 'Merge request IID' },
      limit: { type: 'number', description: 'Max results (default 20)' },
    },
    required: ['project_id', 'mr_iid'],
  },
};

const listMrPipelinesTool: Tool = {
  name: 'listMrPipelines',
  description: 'List pipelines associated with a merge request',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      mr_iid: { type: 'number', description: 'Merge request IID' },
      limit: { type: 'number', description: 'Max results (default 10)' },
    },
    required: ['project_id', 'mr_iid'],
  },
};

const listMrNotesTool: Tool = {
  name: 'listMrNotes',
  description: 'List notes/comments on a merge request',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      mr_iid: { type: 'number', description: 'Merge request IID' },
      limit: { type: 'number', description: 'Max results (default 20)' },
    },
    required: ['project_id', 'mr_iid'],
  },
};

const createMrNoteTool: Tool = {
  name: 'createMrNote',
  description: 'Add a comment/note to a merge request',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      mr_iid: { type: 'number', description: 'Merge request IID' },
      body: { type: 'string', description: 'Comment body' },
    },
    required: ['project_id', 'mr_iid', 'body'],
  },
};

/**
 * Tool handler function
 * @param client - GitLab client instance
 */
export function createMrNotesTools(client: GitLabClient | null): ToolDefinition[] {
  const unconfigured = async () =>
    errorResult('GitLab not configured. Run: speedwave setup gitlab');
  if (!client) {
    return [
      { tool: listMrCommitsTool, handler: unconfigured },
      { tool: listMrPipelinesTool, handler: unconfigured },
      { tool: listMrNotesTool, handler: unconfigured },
      { tool: createMrNoteTool, handler: unconfigured },
    ];
  }

  return [
    {
      tool: listMrCommitsTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, mr_iid, limit } = params as {
          project_id: string | number;
          mr_iid: number;
          limit?: number;
        };
        const result = await c.listMrCommits(project_id, mr_iid, limit);
        return jsonResult(result);
      }),
    },
    {
      tool: listMrPipelinesTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, mr_iid, limit } = params as {
          project_id: string | number;
          mr_iid: number;
          limit?: number;
        };
        const result = await c.listMrPipelines(project_id, mr_iid, limit);
        return jsonResult(result);
      }),
    },
    {
      tool: listMrNotesTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, mr_iid, limit } = params as {
          project_id: string | number;
          mr_iid: number;
          limit?: number;
        };
        const result = await c.listMrNotes(project_id, mr_iid, limit);
        return jsonResult(result);
      }),
    },
    {
      tool: createMrNoteTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, mr_iid, body } = params as {
          project_id: string | number;
          mr_iid: number;
          body: string;
        };
        const result = await c.createMrNote(project_id, mr_iid, body);
        return jsonResult(result);
      }),
    },
  ];
}
