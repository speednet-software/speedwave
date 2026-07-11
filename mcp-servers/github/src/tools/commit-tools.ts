/**
 * Commit Tools - 4 tools for GitHub commit operations
 */

import {
  META_KEYS,
  Tool,
  ToolDefinition,
  jsonResult,
  READ_ONLY_ANNOTATIONS,
} from '@speedwave/mcp-shared';
import { GitHubClient } from '../client.js';
import { GitHubCommit } from '../types.js';
import { withValidation } from './validation.js';
import { DIFF_OUTPUT_SCHEMA } from './schemas.js';
import { TOOL_NAMES } from '../tool-names.js';

/**
 * Maps a normalized commit to the compact `{ sha, message, author, date, html_url }` summary returned by the commit-list tools.
 * @param c - Normalized commit
 */
function commitSummary(c: GitHubCommit): {
  sha: string;
  message: string;
  author: string;
  date: string;
  html_url: string;
} {
  return {
    sha: c.sha,
    message: c.commit.message,
    author: c.commit.author.name,
    date: c.commit.author.date,
    html_url: c.html_url,
  };
}

const listCommitsTool: Tool = {
  name: TOOL_NAMES.LIST_COMMITS,
  description:
    'List commits in a repository with optional filters (branch/tag, path, author, date range).',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.USER_SCOPED]: true,
    [META_KEYS.CURRENT_USER_TOOL]: TOOL_NAMES.GET_CURRENT_USER,
  },
  keywords: ['github', 'commits', 'history', 'log', 'git', 'list'],
  example:
    'const { commits, count } = await github.listCommits({ owner: "octocat", repo: "hello", sha: "main", limit: 10 })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      sha: { type: 'string', description: 'Branch/tag/SHA to start from' },
      path: { type: 'string', description: 'Only commits touching this path' },
      author: {
        type: 'string',
        description: `GitHub login or email. Does NOT accept 'me'. Resolve the authenticated user's login via ${TOOL_NAMES.GET_CURRENT_USER} first, then pass it here.`,
      },
      since: { type: 'string', description: 'ISO 8601 date' },
      until: { type: 'string', description: 'ISO 8601 date' },
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
      commits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            sha: { type: 'string' },
            message: { type: 'string' },
            author: { type: 'string' },
            date: { type: 'string' },
            html_url: { type: 'string' },
          },
        },
      },
      count: { type: 'number' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: recent commits on the default branch',
      input: { owner: 'octocat', repo: 'hello-world' },
    },
    {
      description: 'Partial: commits touching a path',
      input: { owner: 'octocat', repo: 'hello-world', path: 'src/index.ts', limit: 20 },
    },
    {
      description: 'Full: filtered by branch, author, and date range',
      input: {
        owner: 'octocat',
        repo: 'hello-world',
        sha: 'main',
        author: 'octocat',
        since: '2024-01-01T00:00:00Z',
        until: '2024-02-01T00:00:00Z',
        limit: 50,
      },
    },
  ],
};

const listBranchCommitsTool: Tool = {
  name: 'listBranchCommits',
  description: 'List commits on a specific branch.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['github', 'commits', 'branch', 'history', 'log', 'git'],
  example:
    'const { commits, count } = await github.listBranchCommits({ owner: "octocat", repo: "hello", branch: "main" })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      branch: { type: 'string', description: 'Branch name' },
      limit: {
        type: 'number',
        description: 'Max results (default 100 when omitted; any positive value honored)',
      },
    },
    required: ['owner', 'repo', 'branch'],
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
            sha: { type: 'string' },
            message: { type: 'string' },
            author: { type: 'string' },
            date: { type: 'string' },
            html_url: { type: 'string' },
          },
        },
      },
      count: { type: 'number' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: commits on main',
      input: { owner: 'octocat', repo: 'hello-world', branch: 'main' },
    },
    {
      description: 'Partial: commits on a feature branch',
      input: { owner: 'octocat', repo: 'hello-world', branch: 'feature/login' },
    },
    {
      description: 'Full: limited commits on a release branch',
      input: { owner: 'octocat', repo: 'hello-world', branch: 'release/1.0', limit: 25 },
    },
  ],
};

const searchCommitsTool: Tool = {
  name: 'searchCommits',
  description: 'Search commits across GitHub, optionally scoped to a single repository.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: true,
    [META_KEYS.USER_SCOPED]: true,
    [META_KEYS.CURRENT_USER_TOOL]: TOOL_NAMES.GET_CURRENT_USER,
  },
  keywords: ['github', 'commits', 'search', 'find', 'git'],
  example:
    'const { commits, count } = await github.searchCommits({ query: "fix login", owner: "octocat", repo: "hello" })',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          "Commit search query (GitHub commit-search syntax), e.g. 'author:octocat' or 'author:@me' for the authenticated user's own commits.",
      },
      owner: {
        type: 'string',
        description: 'Repository owner to scope the search to (requires repo)',
      },
      repo: {
        type: 'string',
        description: 'Repository name to scope the search to (requires owner)',
      },
      limit: {
        type: 'number',
        description: 'Max results (default 100 when omitted; any positive value honored)',
      },
    },
    required: ['query'],
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
            sha: { type: 'string' },
            message: { type: 'string' },
            author: { type: 'string' },
            date: { type: 'string' },
            html_url: { type: 'string' },
          },
        },
      },
      count: { type: 'number' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: search commit messages globally',
      input: { query: 'refactor parser' },
    },
    {
      description: 'Partial: scoped to one repository',
      input: { query: 'fix bug', owner: 'octocat', repo: 'hello-world' },
    },
    {
      description: 'Full: scoped search with a result limit',
      input: { query: 'release', owner: 'octocat', repo: 'hello-world', limit: 10 },
    },
  ],
};

const getCommitDiffTool: Tool = {
  name: 'getCommitDiff',
  description:
    'Returns the unified diff for a commit as `{ diff }` (the diff text under a `diff` field).',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['github', 'commit', 'diff', 'changes', 'patch', 'git'],
  example:
    'const { diff } = await github.getCommitDiff({ owner: "octocat", repo: "hello", ref: "abc123" })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      ref: {
        type: 'string',
        description:
          'Commit SHA, branch, or tag. Obtain a SHA from listCommits, or a branch name from listBranches.',
      },
    },
    required: ['owner', 'repo', 'ref'],
  },
  outputSchema: DIFF_OUTPUT_SCHEMA,
  inputExamples: [
    {
      description: 'Minimal: diff by short SHA',
      input: { owner: 'octocat', repo: 'hello-world', ref: 'abc123' },
    },
    {
      description: 'Partial: diff by full SHA',
      input: {
        owner: 'octocat',
        repo: 'hello-world',
        ref: 'abc123def456789012345678901234567890abcd',
      },
    },
    {
      description: 'Full: diff by branch name',
      input: { owner: 'octocat', repo: 'hello-world', ref: 'main' },
    },
  ],
};

/**
 * Builds the commit tool definitions for the GitHub worker.
 * @param client - GitHub client instance (null when the service is not configured)
 */
export function createCommitTools(client: GitHubClient | null): ToolDefinition[] {
  return [
    {
      tool: listCommitsTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, ...options } = params as {
          owner: string;
          repo: string;
          sha?: string;
          path?: string;
          author?: string;
          since?: string;
          until?: string;
          limit?: number;
        };
        const result = await c.listCommits(owner, repo, options);
        return jsonResult({ commits: result.map(commitSummary), count: result.length });
      }),
    },
    {
      tool: listBranchCommitsTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, branch, limit } = params as {
          owner: string;
          repo: string;
          branch: string;
          limit?: number;
        };
        const result = await c.listBranchCommits(owner, repo, branch, { limit });
        return jsonResult({ commits: result.map(commitSummary), count: result.length });
      }),
    },
    {
      tool: searchCommitsTool,
      handler: withValidation(client, async (c, params) => {
        const { query, ...options } = params as {
          query: string;
          owner?: string;
          repo?: string;
          limit?: number;
        };
        const result = await c.searchCommits(query, options);
        return jsonResult({ commits: result.map(commitSummary), count: result.length });
      }),
    },
    {
      tool: getCommitDiffTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, ref } = params as { owner: string; repo: string; ref: string };
        const diff = await c.getCommitDiff(owner, repo, ref);
        return jsonResult({ diff });
      }),
    },
  ];
}
