/**
 * MR Notes Tools - 4 tools for GitLab MR commits, pipelines, notes
 */

import {
  Tool,
  ToolDefinition,
  jsonResult,
  errorResult,
  notConfiguredMessage,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
} from '@speedwave/mcp-shared';
import { GitLabClient } from '../client.js';
import { withValidation } from './validation.js';

const listMrCommitsTool: Tool = {
  name: 'listMrCommits',
  description: 'List commits in a merge request',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['gitlab', 'merge', 'request', 'commits', 'history'],
  example:
    'const commits = await gitlab.listMrCommits({ project_id: "speedwave/core", mr_iid: 42 })',
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
      commits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            author_name: { type: 'string' },
            created_at: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'List MR commits',
      input: { project_id: 'my-group/my-project', mr_iid: 123 },
    },
  ],
};

const listMrPipelinesTool: Tool = {
  name: 'listMrPipelines',
  description: 'List pipelines associated with a merge request',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['gitlab', 'merge', 'request', 'pipelines', 'ci'],
  example:
    'const pipelines = await gitlab.listMrPipelines({ project_id: "speedwave/core", mr_iid: 42 })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      mr_iid: { type: 'number', description: 'Merge request IID' },
      limit: { type: 'number', description: 'Max results (default 10)' },
    },
    required: ['project_id', 'mr_iid'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      pipelines: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            status: { type: 'string' },
            ref: { type: 'string' },
            created_at: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'List MR pipelines',
      input: { project_id: 'my-group/my-project', mr_iid: 123 },
    },
  ],
};

const listMrNotesTool: Tool = {
  name: 'listMrNotes',
  description: 'List notes/comments on a merge request',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['gitlab', 'merge', 'request', 'notes', 'comments'],
  example: 'const notes = await gitlab.listMrNotes({ project_id: "speedwave/core", mr_iid: 42 })',
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
      notes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            body: { type: 'string' },
            author: { type: 'object' },
            created_at: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'List MR notes',
      input: { project_id: 'my-group/my-project', mr_iid: 123 },
    },
  ],
};

const createMrNoteTool: Tool = {
  name: 'createMrNote',
  description: 'Add a comment/note to a merge request',
  annotations: WRITE_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['gitlab', 'merge', 'request', 'comment', 'note'],
  example: 'await gitlab.createMrNote({ project_id: "speedwave/core", mr_iid: 42, body: "LGTM!" })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      mr_iid: { type: 'number', description: 'Merge request IID' },
      body: { type: 'string', description: 'Comment body' },
    },
    required: ['project_id', 'mr_iid', 'body'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      note: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          body: { type: 'string' },
          author: { type: 'object' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Add comment to MR',
      input: {
        project_id: 'my-group/my-project',
        mr_iid: 123,
        body: 'Looks good!',
      },
    },
  ],
};

/**
 * Tool handler function
 * @param client - GitLab client instance
 */
export function createMrNotesTools(client: GitLabClient | null): ToolDefinition[] {
  const unconfigured = async () => errorResult(notConfiguredMessage('GitLab'));
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
