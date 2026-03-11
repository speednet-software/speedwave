/**
 * Merge Request Tools - 7 tools for GitLab MR operations
 */

import { Tool, ToolDefinition, jsonResult, errorResult } from '@speedwave/mcp-shared';
import { GitLabClient } from '../client.js';
import { withValidation } from './validation.js';

const listMrIdsTool: Tool = {
  name: 'listMrIds',
  description: 'List merge request IIDs. Use get_mr_full for details.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      state: {
        type: 'string',
        enum: ['opened', 'closed', 'merged', 'all'],
        description: 'MR state',
      },
      author_username: { type: 'string', description: 'Filter by author' },
      limit: { type: 'number', description: 'Max results (default 100)' },
    },
    required: ['project_id'],
  },
};

const getMrFullTool: Tool = {
  name: 'getMrFull',
  description: 'Get complete merge request data. No truncation.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      mr_iid: { type: 'number', description: 'MR internal ID' },
    },
    required: ['project_id', 'mr_iid'],
  },
};

const createMergeRequestTool: Tool = {
  name: 'createMergeRequest',
  description: 'Create a new merge request',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      source_branch: { type: 'string', description: 'Source branch name' },
      target_branch: { type: 'string', description: 'Target branch name' },
      title: { type: 'string', description: 'Merge request title' },
      description: { type: 'string', description: 'Merge request description' },
      labels: { type: 'string', description: 'Comma-separated labels' },
      remove_source_branch: { type: 'boolean', description: 'Remove source branch after merge' },
    },
    required: ['project_id', 'source_branch', 'target_branch', 'title'],
  },
};

const approveMergeRequestTool: Tool = {
  name: 'approveMergeRequest',
  description: 'Approve a merge request',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      mr_iid: { type: 'number', description: 'Merge request IID' },
    },
    required: ['project_id', 'mr_iid'],
  },
};

const mergeMergeRequestTool: Tool = {
  name: 'mergeMergeRequest',
  description: 'Merge a merge request',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      mr_iid: { type: 'number', description: 'Merge request IID' },
      squash: { type: 'boolean', description: 'Squash commits on merge' },
      should_remove_source_branch: {
        type: 'boolean',
        description: 'Remove source branch after merge',
      },
      auto_merge: { type: 'boolean', description: 'Merge when pipeline succeeds' },
      sha: { type: 'string', description: 'Expected SHA of source branch head' },
    },
    required: ['project_id', 'mr_iid'],
  },
};

const updateMergeRequestTool: Tool = {
  name: 'updateMergeRequest',
  description: 'Update an existing merge request',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      mr_iid: { type: 'number', description: 'Merge request IID' },
      title: { type: 'string', description: 'New title' },
      description: { type: 'string', description: 'New description' },
      target_branch: { type: 'string', description: 'New target branch' },
      state_event: { type: 'string', description: 'State event: close or reopen' },
      labels: { type: 'string', description: 'Comma-separated labels' },
    },
    required: ['project_id', 'mr_iid'],
  },
};

const getMrChangesTool: Tool = {
  name: 'getMrChanges',
  description: 'Get diff/changes of a merge request',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      mr_iid: { type: 'number', description: 'Merge request IID' },
    },
    required: ['project_id', 'mr_iid'],
  },
};

/**
 * Tool handler function
 * @param client - GitLab client instance
 */
export function createMrTools(client: GitLabClient | null): ToolDefinition[] {
  const unconfigured = async () =>
    errorResult('GitLab not configured. Run: speedwave setup gitlab');
  if (!client) {
    return [
      { tool: listMrIdsTool, handler: unconfigured },
      { tool: getMrFullTool, handler: unconfigured },
      { tool: createMergeRequestTool, handler: unconfigured },
      { tool: approveMergeRequestTool, handler: unconfigured },
      { tool: mergeMergeRequestTool, handler: unconfigured },
      { tool: updateMergeRequestTool, handler: unconfigured },
      { tool: getMrChangesTool, handler: unconfigured },
    ];
  }

  return [
    {
      tool: listMrIdsTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, ...options } = params as {
          project_id: string | number;
          state?: string;
          author_username?: string;
          limit?: number;
        };
        const result = await c.listMergeRequests(project_id, options);
        return jsonResult({
          mrs: result.map((mr: { iid: number; title: string }) => ({
            iid: mr.iid,
            title: mr.title,
          })),
          count: result.length,
        });
      }),
    },
    {
      tool: getMrFullTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, mr_iid } = params as { project_id: string | number; mr_iid: number };
        const result = await c.showMergeRequest(project_id, mr_iid);
        return jsonResult(result);
      }),
    },
    {
      tool: createMergeRequestTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, ...options } = params as {
          project_id: string | number;
          source_branch: string;
          target_branch: string;
          title: string;
          description?: string;
          labels?: string;
          remove_source_branch?: boolean;
        };
        const result = await c.createMergeRequest(project_id, options);
        return jsonResult(result);
      }),
    },
    {
      tool: approveMergeRequestTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, mr_iid } = params as { project_id: string | number; mr_iid: number };
        await c.approveMergeRequest(project_id, mr_iid);
        return jsonResult({ success: true, message: 'Merge request approved' });
      }),
    },
    {
      tool: mergeMergeRequestTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, mr_iid, ...options } = params as {
          project_id: string | number;
          mr_iid: number;
          squash?: boolean;
          should_remove_source_branch?: boolean;
          auto_merge?: boolean;
          sha?: string;
        };
        const result = await c.mergeMergeRequest(project_id, mr_iid, options);
        return jsonResult(result);
      }),
    },
    {
      tool: updateMergeRequestTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, mr_iid, ...options } = params as {
          project_id: string | number;
          mr_iid: number;
          title?: string;
          description?: string;
          target_branch?: string;
          state_event?: string;
          labels?: string;
        };
        const result = await c.updateMergeRequest(project_id, mr_iid, options);
        return jsonResult(result);
      }),
    },
    {
      tool: getMrChangesTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, mr_iid } = params as { project_id: string | number; mr_iid: number };
        const result = await c.getMrChanges(project_id, mr_iid);
        return jsonResult(result);
      }),
    },
  ];
}
