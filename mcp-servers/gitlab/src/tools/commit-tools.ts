/**
 * Commit Tools - 4 tools for GitLab commit operations
 */

import { Tool, ToolDefinition, jsonResult, errorResult } from '@speedwave/mcp-shared';
import { GitLabClient } from '../client.js';
import { withValidation } from './validation.js';

const listBranchCommitsTool: Tool = {
  name: 'listBranchCommits',
  description: 'List commits on a specific branch',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      branch: { type: 'string', description: 'Branch name' },
      limit: { type: 'number', description: 'Maximum number of commits (default 20)' },
    },
    required: ['project_id', 'branch'],
  },
};

const listCommitsTool: Tool = {
  name: 'listCommits',
  description: 'List commits with filters',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      ref: { type: 'string', description: 'Branch or tag name' },
      since: { type: 'string', description: 'Date filter (ISO 8601)' },
      until: { type: 'string', description: 'Date filter (ISO 8601)' },
      path: { type: 'string', description: 'Filter by file path' },
      limit: { type: 'number', description: 'Max results (default 20)' },
    },
    required: ['project_id'],
  },
};

const searchCommitsTool: Tool = {
  name: 'searchCommits',
  description: 'Search commits by message',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      query: { type: 'string', description: 'Search query' },
      ref: { type: 'string', description: 'Branch or tag name' },
      limit: { type: 'number', description: 'Max results (default 20)' },
    },
    required: ['project_id', 'query'],
  },
};

const getCommitDiffTool: Tool = {
  name: 'getCommitDiff',
  description: 'Get diff of a specific commit',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      commit_sha: { type: 'string', description: 'Commit SHA' },
    },
    required: ['project_id', 'commit_sha'],
  },
};

/**
 * Tool handler function
 * @param client - GitLab client instance
 */
export function createCommitTools(client: GitLabClient | null): ToolDefinition[] {
  const unconfigured = async () =>
    errorResult('GitLab not configured. Run: speedwave setup gitlab');
  if (!client) {
    return [
      { tool: listBranchCommitsTool, handler: unconfigured },
      { tool: listCommitsTool, handler: unconfigured },
      { tool: searchCommitsTool, handler: unconfigured },
      { tool: getCommitDiffTool, handler: unconfigured },
    ];
  }

  return [
    {
      tool: listBranchCommitsTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, branch, limit } = params as {
          project_id: string | number;
          branch: string;
          limit?: number;
        };
        const result = await c.listBranchCommits(project_id, branch, limit);
        return jsonResult(result);
      }),
    },
    {
      tool: listCommitsTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, ...options } = params as {
          project_id: string | number;
          ref?: string;
          since?: string;
          until?: string;
          path?: string;
          limit?: number;
        };
        const result = await c.listCommits(project_id, options);
        return jsonResult(result);
      }),
    },
    {
      tool: searchCommitsTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, query, ...options } = params as {
          project_id: string | number;
          query: string;
          ref?: string;
          limit?: number;
        };
        const result = await c.searchCommits(project_id, query, options);
        return jsonResult(result);
      }),
    },
    {
      tool: getCommitDiffTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, commit_sha } = params as {
          project_id: string | number;
          commit_sha: string;
        };
        const result = await c.getCommitDiff(project_id, commit_sha);
        return jsonResult(result);
      }),
    },
  ];
}
