/**
 * Commit Tools - 4 tools for GitLab commit operations
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

const listBranchCommitsTool: Tool = {
  name: 'listBranchCommits',
  description: 'List commits on a specific branch',
  category: 'read',
  keywords: ['gitlab', 'commits', 'branch', 'history', 'log', 'git'],
  example:
    'const commits = await gitlab.listBranchCommits({ project_id: "speedwave/core", branch: "main" })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      branch: { type: 'string', description: 'Branch name' },
      limit: { type: 'number', description: 'Maximum number of commits (default 20)' },
    },
    required: ['project_id', 'branch'],
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
            id: { type: 'string', description: 'Commit SHA' },
            short_id: { type: 'string' },
            title: { type: 'string' },
            message: { type: 'string' },
            author_name: { type: 'string' },
            author_email: { type: 'string' },
            authored_date: { type: 'string' },
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
      description: 'Minimal: list commits from main',
      input: { project_id: 'my-group/my-project', branch: 'main' },
    },
    {
      description: 'Partial: commits from develop branch',
      input: { project_id: 'web-app', branch: 'develop' },
    },
    {
      description: 'Full: limited commits from feature branch',
      input: { project_id: 'backend-api', branch: 'feature/user-auth', limit: 50 },
    },
  ],
};

const listCommitsTool: Tool = {
  name: 'listCommits',
  description: 'List commits with filters',
  category: 'read',
  keywords: ['gitlab', 'commits', 'history', 'log', 'git'],
  example:
    'const commits = await gitlab.listCommits({ project_id: "speedwave/core", ref: "main", limit: 10 })',
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
            message: { type: 'string' },
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
      description: 'List recent commits',
      input: { project_id: 'my-group/my-project', ref: 'main' },
    },
    {
      description: 'List commits for specific file',
      input: {
        project_id: 'my-group/my-project',
        ref: 'main',
        path: 'src/index.ts',
      },
    },
  ],
};

const searchCommitsTool: Tool = {
  name: 'searchCommits',
  description: 'Search commits by message',
  category: 'read',
  keywords: ['gitlab', 'commits', 'search', 'find', 'git'],
  example:
    'const commits = await gitlab.searchCommits({ project_id: "speedwave/core", query: "fix bug" })',
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
            message: { type: 'string' },
            author_name: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Search commits',
      input: { project_id: 'my-group/my-project', query: 'refactor' },
    },
  ],
};

const getCommitDiffTool: Tool = {
  name: 'getCommitDiff',
  description: 'Get diff of a specific commit',
  category: 'read',
  keywords: ['gitlab', 'commit', 'diff', 'changes', 'files', 'git'],
  example:
    'const diff = await gitlab.getCommitDiff({ project_id: "speedwave/core", commit_sha: "abc123" })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      commit_sha: { type: 'string', description: 'Commit SHA' },
    },
    required: ['project_id', 'commit_sha'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      diffs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            old_path: { type: 'string' },
            new_path: { type: 'string' },
            new_file: { type: 'boolean' },
            deleted_file: { type: 'boolean' },
            diff: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: get commit diff by short SHA',
      input: { project_id: 'my-group/my-project', commit_sha: 'abc123' },
    },
    {
      description: 'Partial: diff by full SHA',
      input: { project_id: 'web-app', commit_sha: 'abc123def456789' },
    },
    {
      description: 'Full: diff for specific project',
      input: { project_id: 'backend-api', commit_sha: 'def456' },
    },
  ],
};

/**
 * Tool handler function
 * @param client - GitLab client instance
 */
export function createCommitTools(client: GitLabClient | null): ToolDefinition[] {
  const unconfigured = async () => errorResult(notConfiguredMessage('GitLab'));
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
