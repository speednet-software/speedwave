/**
 * Branch Tools - 5 tools for GitHub branches
 */

import {
  META_KEYS,
  Tool,
  ToolDefinition,
  jsonResult,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  DESTRUCTIVE_ANNOTATIONS,
} from '@speedwave/mcp-shared';
import { GitHubClient } from '../client.js';
import { withValidation } from './validation.js';
import { TOOL_NAMES } from '../tool-names.js';

const BRANCH_ITEM_PROPERTIES = {
  name: { type: 'string' },
  sha: { type: 'string' },
  protected: { type: 'boolean' },
};

const listBranchesTool: Tool = {
  name: TOOL_NAMES.LIST_BRANCHES,
  description: 'List branches in a repository.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: false },
  keywords: ['github', 'branches', 'list', 'git', 'refs'],
  example:
    'const { branches, count } = await github.listBranches({ owner: "octocat", repo: "hello" })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      limit: {
        type: 'number',
        description: 'Max results (default 100 when omitted; any positive value honored)',
      },
    },
    required: ['owner', 'repo'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      branches: { type: 'array', items: { type: 'object', properties: BRANCH_ITEM_PROPERTIES } },
      count: { type: 'number' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    { description: 'Minimal: list branches', input: { owner: 'octocat', repo: 'hello-world' } },
    {
      description: 'Full: list branches with a limit',
      input: { owner: 'octocat', repo: 'hello-world', limit: 50 },
    },
  ],
};

const getBranchTool: Tool = {
  name: TOOL_NAMES.GET_BRANCH,
  description: 'Get detailed information about a specific branch.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['github', 'branch', 'get', 'show', 'git'],
  example:
    'const branch = await github.getBranch({ owner: "octocat", repo: "hello", branch: "main" })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      branch: { type: 'string', description: 'Branch name' },
    },
    required: ['owner', 'repo', 'branch'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      name: { type: 'string' },
      sha: { type: 'string' },
      protected: { type: 'boolean' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Get details of a branch',
      input: { owner: 'octocat', repo: 'hello-world', branch: 'main' },
    },
  ],
};

const createBranchTool: Tool = {
  name: 'createBranch',
  description:
    'Create a new branch from a SHA or an existing branch. Provide either from_sha or from_branch.',
  annotations: WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['github', 'branch', 'create', 'new', 'git'],
  example:
    'const branch = await github.createBranch({ owner: "octocat", repo: "hello", branch: "feature/x", from_branch: "main" })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      branch: { type: 'string', description: 'Name for the new branch' },
      from_sha: {
        type: 'string',
        description:
          'SHA to branch from. Obtain from listCommits, getBranch, or compareBranches. Provide either from_sha or from_branch.',
      },
      from_branch: {
        type: 'string',
        description:
          'Branch name to branch from (its head SHA is used). Obtain from listBranches. Provide either from_sha or from_branch.',
      },
    },
    required: ['owner', 'repo', 'branch'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      name: { type: 'string' },
      sha: { type: 'string' },
      protected: { type: 'boolean' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: create a branch from another branch',
      input: { owner: 'octocat', repo: 'hello-world', branch: 'feature/auth', from_branch: 'main' },
    },
    {
      description: 'Full: create a branch from a commit SHA',
      input: {
        owner: 'octocat',
        repo: 'hello-world',
        branch: 'hotfix/bug',
        from_sha: 'abc123def456',
      },
    },
  ],
};

const deleteBranchTool: Tool = {
  name: 'deleteBranch',
  description: 'Delete a branch from the repository.',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['github', 'branch', 'delete', 'remove', 'git'],
  example: 'await github.deleteBranch({ owner: "octocat", repo: "hello", branch: "feature/old" })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      branch: { type: 'string', description: 'Branch name to delete' },
    },
    required: ['owner', 'repo', 'branch'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      deleted: { type: 'boolean' },
      branch: { type: 'string' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Delete a branch',
      input: { owner: 'octocat', repo: 'hello-world', branch: 'feature/obsolete' },
    },
  ],
};

const compareBranchesTool: Tool = {
  name: 'compareBranches',
  description: 'Compare two refs (branches or commits) and return the diff summary.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['github', 'compare', 'diff', 'branches', 'git', 'ahead', 'behind'],
  example:
    'const cmp = await github.compareBranches({ owner: "octocat", repo: "hello", base: "main", head: "develop" })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      base: {
        type: 'string',
        description:
          'Base ref (branch name or commit SHA). See listBranches for branch names, or listCommits for SHAs.',
      },
      head: {
        type: 'string',
        description:
          'Head ref (branch name or commit SHA). See listBranches for branch names, or listCommits for SHAs.',
      },
    },
    required: ['owner', 'repo', 'base', 'head'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      ahead_by: { type: 'number' },
      behind_by: { type: 'number' },
      total_commits: { type: 'number' },
      status: { type: 'string' },
      commits: {
        type: 'array',
        items: {
          type: 'object',
          properties: { sha: { type: 'string' }, message: { type: 'string' } },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Compare two branches',
      input: { owner: 'octocat', repo: 'hello-world', base: 'main', head: 'feature/new' },
    },
  ],
};

/**
 * Builds the branch tool definitions.
 * @param client - GitHub client instance (null when the service is not configured)
 */
export function createBranchTools(client: GitHubClient | null): ToolDefinition[] {
  return [
    {
      tool: listBranchesTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, ...options } = params as {
          owner: string;
          repo: string;
          limit?: number;
        };
        const result = await c.listBranches(owner, repo, options);
        return jsonResult({
          branches: result.map((b) => ({
            name: b.name,
            sha: b.commit.sha,
            protected: b.protected,
          })),
          count: result.length,
        });
      }),
    },
    {
      tool: getBranchTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, branch } = params as { owner: string; repo: string; branch: string };
        const result = await c.getBranch(owner, repo, branch);
        return jsonResult({
          name: result.name,
          sha: result.commit.sha,
          protected: result.protected,
        });
      }),
    },
    {
      tool: createBranchTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, ...rest } = params as {
          owner: string;
          repo: string;
          branch: string;
          from_sha?: string;
          from_branch?: string;
        };
        const result = await c.createBranch(owner, repo, rest);
        return jsonResult({
          name: result.name,
          sha: result.commit.sha,
          protected: result.protected,
        });
      }),
    },
    {
      tool: deleteBranchTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, branch } = params as { owner: string; repo: string; branch: string };
        const result = await c.deleteBranch(owner, repo, branch);
        return jsonResult(result);
      }),
    },
    {
      tool: compareBranchesTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, base, head } = params as {
          owner: string;
          repo: string;
          base: string;
          head: string;
        };
        const result = await c.compareBranches(owner, repo, base, head);
        return jsonResult({
          ahead_by: result.ahead_by,
          behind_by: result.behind_by,
          total_commits: result.total_commits,
          status: result.status,
          commits: result.commits.map((commit) => ({
            sha: commit.sha,
            message: commit.commit.message,
          })),
        });
      }),
    },
  ];
}
