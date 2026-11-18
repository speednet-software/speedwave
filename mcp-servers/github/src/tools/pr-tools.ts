/**
 * Pull Request Tools - 7 tools for GitHub pull requests
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
import { DIFF_OUTPUT_SCHEMA } from './schemas.js';
import { withValidation } from './validation.js';
import { TOOL_NAMES } from '../tool-names.js';

const PR_ITEM_PROPERTIES = {
  number: { type: 'number' },
  title: { type: 'string' },
  state: { type: 'string', enum: ['open', 'closed'] },
  body: { type: 'string' },
  merged: { type: 'boolean' },
  head: {
    type: 'object',
    properties: { ref: { type: 'string' }, sha: { type: 'string' } },
  },
  base: { type: 'object', properties: { ref: { type: 'string' } } },
  user: { type: 'object', properties: { login: { type: 'string' } } },
  draft: { type: 'boolean' },
  html_url: { type: 'string' },
  created_at: { type: 'string' },
  updated_at: { type: 'string' },
  merge_commit_sha: { type: 'string' },
};

/** Output schema shared by tools returning a single PR at the TOP level (never nested under a 'pr' key). */
const PR_OUTPUT_SCHEMA = {
  type: 'object' as const,
  properties: { success: { type: 'boolean' }, ...PR_ITEM_PROPERTIES, error: { type: 'string' } },
  required: ['success'],
};

const listPullRequestsTool: Tool = {
  name: TOOL_NAMES.LIST_PULL_REQUESTS,
  description: `List pull requests in a repository with optional filters. There is no author filter: for 'my PRs' questions, resolve the login with ${TOOL_NAMES.GET_CURRENT_USER}, then match it against each PR's user.login yourself (this worker has no PR-search tool).`,
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: false },
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
  description:
    'Get a pull request: state, merged, head.sha, base.ref, author, dates, draft and merge_commit_sha once merged.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
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
  outputSchema: PR_OUTPUT_SCHEMA,
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
  _meta: { [META_KEYS.DEFER_LOADING]: true },
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
  outputSchema: PR_OUTPUT_SCHEMA,
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
  description:
    'Request an asynchronous merge of a pull request and wait up to 20 seconds for the result. On a base branch with a merge queue the PR joins the queue (status enqueued); otherwise it merges at once (status merged). status failed carries the reason in message. On status pending GitHub has not decided yet: call again, the call waits for the same request. Do not pass merge_method or commit_title for a merge queue, GitHub rejects them.',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['github', 'pr', 'pull', 'request', 'merge', 'squash', 'rebase'],
  example: 'await github.mergePullRequest({ owner: "octocat", repo: "hello", number: 42 })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      number: { type: 'number', description: 'Pull request number' },
      merge_method: {
        type: 'string',
        enum: ['merge', 'squash', 'rebase'],
        description:
          'Merge strategy for a direct merge only; omit it when the base branch has a merge queue',
      },
      commit_title: {
        type: 'string',
        description:
          'Commit title for a direct merge only; omit it when the base branch has a merge queue',
      },
    },
    required: ['owner', 'repo', 'number'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      status: { type: 'string', enum: ['merged', 'enqueued', 'pending', 'failed'] },
      merged: { type: 'boolean' },
      sha: { type: 'string' },
      message: { type: 'string' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: merge, or join the merge queue when the base branch has one',
      input: { owner: 'octocat', repo: 'hello-world', number: 1 },
    },
    {
      description: 'Partial: squash merge (direct merge only, no merge queue)',
      input: { owner: 'octocat', repo: 'hello-world', number: 1, merge_method: 'squash' },
    },
    {
      description: 'Full: direct squash merge with a custom commit title (no merge queue)',
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
  _meta: { [META_KEYS.DEFER_LOADING]: true },
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
  outputSchema: PR_OUTPUT_SCHEMA,
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
    'Get the unified diff for a pull request as `{ diff }` (the diff text under a `diff` field). Large for big PRs.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['github', 'pr', 'pull', 'request', 'diff', 'patch', 'changes'],
  example:
    'const { diff } = await github.getPrDiff({ owner: "octocat", repo: "hello", number: 42 })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      number: { type: 'number', description: 'Pull request number' },
    },
    required: ['owner', 'repo', 'number'],
  },
  outputSchema: DIFF_OUTPUT_SCHEMA,
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
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['github', 'pr', 'pull', 'request', 'files', 'changes', 'diff'],
  example:
    'const { files, count } = await github.getPrFiles({ owner: "octocat", repo: "hello", number: 42 })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      number: { type: 'number', description: 'Pull request number' },
      limit: {
        type: 'number',
        description: 'Max results (default 100 when omitted; any positive value honored)',
      },
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
        return jsonResult({ prs: result, count: result.length });
      }),
    },
    {
      tool: getPullRequestTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, number } = params as { owner: string; repo: string; number: number };
        const result = await c.getPullRequest(owner, repo, number);
        return jsonResult(result);
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
        return jsonResult(result);
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
        return jsonResult(result);
      }),
    },
    {
      tool: getPrDiffTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, number } = params as { owner: string; repo: string; number: number };
        const diff = await c.getPrDiff(owner, repo, number);
        return jsonResult({ diff });
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
