/**
 * Branch Tools - 5 tools for GitLab branch operations
 */

import {
  Tool,
  ToolDefinition,
  jsonResult,
  errorResult,
  notConfiguredMessage,
} from '@speedwave/mcp-shared';
import { GitLabClient } from '../client.js';
import { withValidation } from './validation.js';

const listBranchesTool: Tool = {
  name: 'listBranches',
  description: 'List branches in a project',
  category: 'read',
  keywords: ['gitlab', 'branches', 'list', 'git', 'refs'],
  example: 'const branches = await gitlab.listBranches({ project_id: "speedwave/core" })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      search: { type: 'string', description: 'Search by branch name' },
      limit: { type: 'number', description: 'Max results (default 20)' },
    },
    required: ['project_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      branches: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            merged: { type: 'boolean' },
            protected: { type: 'boolean' },
            default: { type: 'boolean' },
            web_url: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'List all branches',
      input: { project_id: 'my-group/my-project' },
    },
    {
      description: 'Search branches',
      input: { project_id: 'my-group/my-project', search: 'feature' },
    },
  ],
};

const getBranchTool: Tool = {
  name: 'getBranch',
  description: 'Get details of a specific branch',
  category: 'read',
  keywords: ['gitlab', 'branch', 'get', 'show', 'git'],
  example:
    'const branch = await gitlab.getBranch({ project_id: "speedwave/core", branch: "main" })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      branch: { type: 'string', description: 'Branch name' },
    },
    required: ['project_id', 'branch'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      branch: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          commit: { type: 'object' },
          merged: { type: 'boolean' },
          protected: { type: 'boolean' },
          default: { type: 'boolean' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Get branch details',
      input: { project_id: 'my-group/my-project', branch: 'develop' },
    },
  ],
};

const createBranchTool: Tool = {
  name: 'createBranch',
  description: 'Create a new branch',
  category: 'write',
  keywords: ['gitlab', 'branch', 'create', 'new', 'git'],
  example:
    'const branch = await gitlab.createBranch({ project_id: "speedwave/core", branch: "feature/new", ref: "main" })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      branch: { type: 'string', description: 'New branch name' },
      ref: { type: 'string', description: 'Source branch or commit SHA' },
    },
    required: ['project_id', 'branch', 'ref'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      branch: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          commit: { type: 'object' },
          web_url: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Create branch from main',
      input: { project_id: 'my-group/my-project', branch: 'feature/auth', ref: 'main' },
    },
  ],
};

const deleteBranchTool: Tool = {
  name: 'deleteBranch',
  description: 'Delete a branch',
  category: 'delete',
  keywords: ['gitlab', 'branch', 'delete', 'remove', 'git'],
  example: 'await gitlab.deleteBranch({ project_id: "speedwave/core", branch: "feature/old" })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      branch: { type: 'string', description: 'Branch name to delete' },
    },
    required: ['project_id', 'branch'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Delete branch',
      input: { project_id: 'my-group/my-project', branch: 'feature/obsolete' },
    },
  ],
};

const compareBranchesTool: Tool = {
  name: 'compareBranches',
  description: 'Compare two branches',
  category: 'read',
  keywords: ['gitlab', 'compare', 'diff', 'branches', 'git'],
  example:
    'const diff = await gitlab.compareBranches({ project_id: "speedwave/core", from: "main", to: "develop" })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      from: { type: 'string', description: 'Source branch or commit' },
      to: { type: 'string', description: 'Target branch or commit' },
    },
    required: ['project_id', 'from', 'to'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      comparison: {
        type: 'object',
        properties: {
          commits: { type: 'array' },
          diffs: { type: 'array' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Compare branches',
      input: { project_id: 'my-group/my-project', from: 'main', to: 'feature/new' },
    },
  ],
};

/**
 * Tool handler function
 * @param client - GitLab client instance
 */
export function createBranchTools(client: GitLabClient | null): ToolDefinition[] {
  const unconfigured = async () => errorResult(notConfiguredMessage('GitLab'));
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
