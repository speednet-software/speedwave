/**
 * Pull Request Tools - 7 tools for GitHub pull requests
 */

import {
  Tool,
  ToolDefinition,
  jsonResult,
  textResult,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  DESTRUCTIVE_ANNOTATIONS,
} from '@speedwave/mcp-shared';
import { GitHubClient } from '../client.js';
import { GitHubPullRequest } from '../types.js';
import { withValidation } from './validation.js';

const PR_ITEM_PROPERTIES = {
  number: { type: 'number' },
  title: { type: 'string' },
  state: { type: 'string', enum: ['open', 'closed'] },
  head: { type: 'string' },
  base: { type: 'string' },
  user: { type: 'string' },
  draft: { type: 'boolean' },
  html_url: { type: 'string' },
};

const listPullRequestsTool: Tool = {
  name: 'listPullRequests',
  description: 'List pull requests in a repository with optional filters.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: false },
  keywords: ['github', 'pr', 'pull', 'request', 'list', 'merge'],
  example:
    'const { prs, count } = await github.listPullRequests({ owner: "octocat", repo: "hello", state: "open" })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      state: {
        type: 'string',
        enum: ['open', 'closed', 'all'],
        description: 'Filter by state (default open)',
      },
      head: { type: 'string', description: "Filter by head branch, format 'user:branch'" },
      base: { type: 'string', description: 'Filter by base branch' },
      limit: { type: 'number', description: 'Max results, default 100' },
    },
    required: ['owner', 'repo'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      prs: { type: 'array', items: { type: 'object', properties: PR_ITEM_PROPERTIES } },
      count: { type: 'number' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: open PRs for a repo',
      input: { owner: 'octocat', repo: 'hello-world' },
    },
    {
      description: 'Partial: all PRs (open and closed)',
      input: { owner: 'octocat', repo: 'hello-world', state: 'all' },
    },
    {
      description: 'Full: open PRs targeting main, limited',
      input: { owner: 'octocat', repo: 'hello-world', state: 'open', base: 'main', limit: 20 },
    },
  ],
};

const getPullRequestTool: Tool = {
  name: 'getPullRequest',
  description: 'Get detailed information about a specific pull request.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['github', 'pr', 'pull', 'request', 'get', 'show', 'detail'],
  example:
    'const pr = await github.getPullRequest({ owner: "octocat", repo: "hello", number: 42 })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      number: { type: 'number', description: 'Pull request number' },
    },
    required: ['owner', 'repo', 'number'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      pr: { type: 'object', properties: PR_ITEM_PROPERTIES },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Get a pull request by number',
      input: { owner: 'octocat', repo: 'hello-world', number: 1 },
    },
  ],
};

const createPullRequestTool: Tool = {
  name: 'createPullRequest',
  description: 'Create a new pull request.',
  annotations: WRITE_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['github', 'pr', 'pull', 'request', 'create', 'new', 'open'],
  example:
    'const pr = await github.createPullRequest({ owner: "octocat", repo: "hello", title: "Add feature", head: "feature/x", base: "main" })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      title: { type: 'string', description: 'Pull request title' },
      head: { type: 'string', description: 'Head ref (the branch with the changes)' },
      base: { type: 'string', description: 'Base branch the changes should be merged into' },
      body: { type: 'string', description: 'Pull request description (Markdown)' },
      draft: { type: 'boolean', description: 'Create the pull request as a draft' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      pr: { type: 'object', properties: PR_ITEM_PROPERTIES },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: create a PR with required fields',
      input: {
        owner: 'octocat',
        repo: 'hello-world',
        title: 'Add docs',
        head: 'docs',
        base: 'main',
      },
    },
    {
      description: 'Full: create a draft PR with a description',
      input: {
        owner: 'octocat',
        repo: 'hello-world',
        title: 'feat: add auth flow',
        head: 'feature/auth',
        base: 'develop',
        body: '## Summary\n- adds JWT validation',
        draft: true,
      },
    },
  ],
};

const mergePullRequestTool: Tool = {
  name: 'mergePullRequest',
  description: 'Merge a pull request.',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['github', 'pr', 'pull', 'request', 'merge', 'squash', 'rebase'],
  example:
    'await github.mergePullRequest({ owner: "octocat", repo: "hello", number: 42, merge_method: "squash" })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      number: { type: 'number', description: 'Pull request number' },
      merge_method: {
        type: 'string',
        enum: ['merge', 'squash', 'rebase'],
        description: 'Merge strategy (default merge)',
      },
      commit_title: { type: 'string', description: 'Commit title for the merge commit' },
    },
    required: ['owner', 'repo', 'number'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      merged: { type: 'boolean' },
      sha: { type: 'string' },
      message: { type: 'string' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: merge with the default strategy',
      input: { owner: 'octocat', repo: 'hello-world', number: 1 },
    },
    {
      description: 'Partial: squash merge',
      input: { owner: 'octocat', repo: 'hello-world', number: 1, merge_method: 'squash' },
    },
    {
      description: 'Full: squash merge with a custom commit title',
      input: {
        owner: 'octocat',
        repo: 'hello-world',
        number: 1,
        merge_method: 'squash',
        commit_title: 'feat: ship it',
      },
    },
  ],
};

const updatePullRequestTool: Tool = {
  name: 'updatePullRequest',
  description: 'Update properties of an existing pull request.',
  annotations: WRITE_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['github', 'pr', 'pull', 'request', 'update', 'edit', 'modify', 'close', 'reopen'],
  example:
    'await github.updatePullRequest({ owner: "octocat", repo: "hello", number: 42, title: "Updated title", state: "closed" })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      number: { type: 'number', description: 'Pull request number' },
      title: { type: 'string', description: 'New pull request title' },
      body: { type: 'string', description: 'New pull request description (Markdown)' },
      state: { type: 'string', enum: ['open', 'closed'], description: 'New state' },
      base: { type: 'string', description: 'New base branch' },
    },
    required: ['owner', 'repo', 'number'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      pr: { type: 'object', properties: PR_ITEM_PROPERTIES },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: rename a PR',
      input: { owner: 'octocat', repo: 'hello-world', number: 1, title: 'New title' },
    },
    {
      description: 'Partial: close a PR',
      input: { owner: 'octocat', repo: 'hello-world', number: 1, state: 'closed' },
    },
    {
      description: 'Full: update title, body and base branch',
      input: {
        owner: 'octocat',
        repo: 'hello-world',
        number: 1,
        title: 'fix: patch',
        body: 'updated',
        base: 'main',
      },
    },
  ],
};

const getPrDiffTool: Tool = {
  name: 'getPrDiff',
  description:
    'Get the unified diff for a pull request. Returns the unified diff as plain text. Large for big PRs.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['github', 'pr', 'pull', 'request', 'diff', 'patch', 'changes'],
  example: 'const diff = await github.getPrDiff({ owner: "octocat", repo: "hello", number: 42 })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      number: { type: 'number', description: 'Pull request number' },
    },
    required: ['owner', 'repo', 'number'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      diff: { type: 'string', description: 'Raw unified diff text' },
    },
  },
  inputExamples: [
    {
      description: 'Get the diff of a pull request',
      input: { owner: 'octocat', repo: 'hello-world', number: 1 },
    },
  ],
};

const getPrFilesTool: Tool = {
  name: 'getPrFiles',
  description: 'List the files changed in a pull request with per-file stats and patches.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['github', 'pr', 'pull', 'request', 'files', 'changes', 'diff'],
  example:
    'const { files, count } = await github.getPrFiles({ owner: "octocat", repo: "hello", number: 42 })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      number: { type: 'number', description: 'Pull request number' },
      limit: { type: 'number', description: 'Max results, default 100' },
    },
    required: ['owner', 'repo', 'number'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            filename: { type: 'string' },
            status: { type: 'string' },
            additions: { type: 'number' },
            deletions: { type: 'number' },
            changes: { type: 'number' },
            patch: { type: 'string' },
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
      description: 'Minimal: list changed files',
      input: { owner: 'octocat', repo: 'hello-world', number: 1 },
    },
    {
      description: 'Full: list changed files with a limit',
      input: { owner: 'octocat', repo: 'hello-world', number: 1, limit: 10 },
    },
  ],
};

/**
 * Maps a normalized GitHub pull request to the compact tool output shape.
 * @param pr - Normalized pull request as returned by GitHubClient
 */
function mapPr(pr: GitHubPullRequest) {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    head: pr.head.ref,
    base: pr.base.ref,
    user: pr.user.login,
    draft: pr.draft,
    html_url: pr.html_url,
  };
}

/**
 * Builds the pull request tool definitions.
 * @param client - GitHub client instance (null when the service is not configured)
 */
export function createPrTools(client: GitHubClient | null): ToolDefinition[] {
  return [
    {
      tool: listPullRequestsTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, ...options } = params as {
          owner: string;
          repo: string;
          state?: 'open' | 'closed' | 'all';
          head?: string;
          base?: string;
          limit?: number;
        };
        const result = await c.listPullRequests(owner, repo, options);
        return jsonResult({ prs: result.map(mapPr), count: result.length });
      }),
    },
    {
      tool: getPullRequestTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, number } = params as { owner: string; repo: string; number: number };
        const result = await c.getPullRequest(owner, repo, number);
        return jsonResult(mapPr(result));
      }),
    },
    {
      tool: createPullRequestTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, ...rest } = params as {
          owner: string;
          repo: string;
          title: string;
          head: string;
          base: string;
          body?: string;
          draft?: boolean;
        };
        const result = await c.createPullRequest(owner, repo, rest);
        return jsonResult(mapPr(result));
      }),
    },
    {
      tool: mergePullRequestTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, number, ...options } = params as {
          owner: string;
          repo: string;
          number: number;
          merge_method?: 'merge' | 'squash' | 'rebase';
          commit_title?: string;
        };
        const result = await c.mergePullRequest(owner, repo, number, options);
        return jsonResult(result);
      }),
    },
    {
      tool: updatePullRequestTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, number, ...rest } = params as {
          owner: string;
          repo: string;
          number: number;
          title?: string;
          body?: string;
          state?: 'open' | 'closed';
          base?: string;
        };
        const result = await c.updatePullRequest(owner, repo, number, rest);
        return jsonResult(mapPr(result));
      }),
    },
    {
      tool: getPrDiffTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, number } = params as { owner: string; repo: string; number: number };
        const result = await c.getPrDiff(owner, repo, number);
        return textResult(result);
      }),
    },
    {
      tool: getPrFilesTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, number, ...options } = params as {
          owner: string;
          repo: string;
          number: number;
          limit?: number;
        };
        const result = await c.getPrFiles(owner, repo, number, options);
        return jsonResult({ files: result, count: result.length });
      }),
    },
  ];
}
