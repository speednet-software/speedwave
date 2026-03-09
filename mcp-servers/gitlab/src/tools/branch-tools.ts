/**
 * Branch Tools - 5 tools for GitLab branch operations
 */

import { Tool, ToolDefinition, jsonResult, errorResult } from '../../../shared/dist/index.js';
import { GitLabClient } from '../client.js';
import { withValidation } from './validation.js';

const listBranchesTool: Tool = {
  name: 'listBranches',
  description: 'List branches in a project',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      search: { type: 'string', description: 'Search by branch name' },
      limit: { type: 'number', description: 'Max results (default 20)' },
    },
    required: ['project_id'],
  },
};

const getBranchTool: Tool = {
  name: 'getBranch',
  description: 'Get details of a specific branch',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      branch: { type: 'string', description: 'Branch name' },
    },
    required: ['project_id', 'branch'],
  },
};

const createBranchTool: Tool = {
  name: 'createBranch',
  description: 'Create a new branch',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      branch: { type: 'string', description: 'New branch name' },
      ref: { type: 'string', description: 'Source branch or commit SHA' },
    },
    required: ['project_id', 'branch', 'ref'],
  },
};

const deleteBranchTool: Tool = {
  name: 'deleteBranch',
  description: 'Delete a branch',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      branch: { type: 'string', description: 'Branch name to delete' },
    },
    required: ['project_id', 'branch'],
  },
};

const compareBranchesTool: Tool = {
  name: 'compareBranches',
  description: 'Compare two branches',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      from: { type: 'string', description: 'Source branch or commit' },
      to: { type: 'string', description: 'Target branch or commit' },
    },
    required: ['project_id', 'from', 'to'],
  },
};

/**
 * Tool handler function
 * @param client - GitLab client instance
 */
export function createBranchTools(client: GitLabClient | null): ToolDefinition[] {
  const unconfigured = async () =>
    errorResult('GitLab not configured. Run: speedwave setup gitlab');
  if (!client) {
    return [
      { tool: listBranchesTool, handler: unconfigured },
      { tool: getBranchTool, handler: unconfigured },
      { tool: createBranchTool, handler: unconfigured },
      { tool: deleteBranchTool, handler: unconfigured },
      { tool: compareBranchesTool, handler: unconfigured },
    ];
  }

  return [
    {
      tool: listBranchesTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, ...options } = params as {
          project_id: string | number;
          search?: string;
          limit?: number;
        };
        const result = await c.listBranches(project_id, options);
        return jsonResult(result);
      }),
    },
    {
      tool: getBranchTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, branch } = params as { project_id: string | number; branch: string };
        const result = await c.getBranch(project_id, branch);
        return jsonResult(result);
      }),
    },
    {
      tool: createBranchTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, branch, ref } = params as {
          project_id: string | number;
          branch: string;
          ref: string;
        };
        const result = await c.createBranch(project_id, branch, ref);
        return jsonResult(result);
      }),
    },
    {
      tool: deleteBranchTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, branch } = params as { project_id: string | number; branch: string };
        await c.deleteBranch(project_id, branch);
        return jsonResult({ success: true, message: `Branch ${branch} deleted` });
      }),
    },
    {
      tool: compareBranchesTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, from, to } = params as {
          project_id: string | number;
          from: string;
          to: string;
        };
        const result = await c.compareBranches(project_id, from, to);
        return jsonResult(result);
      }),
    },
  ];
}
