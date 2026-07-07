/**
 * Issue Tools - 5 tools for GitHub issue operations
 */

import {
  META_KEYS,
  Tool,
  ToolDefinition,
  jsonResult,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
} from '@speedwave/mcp-shared';
import { GitHubClient } from '../client.js';
import { GitHubIssue } from '../types.js';
import { withValidation } from './validation.js';

/**
 * Maps a normalized issue to the compact summary returned by `listIssues`
 * (flattens `user`/`labels`/`assignees` to plain strings; drops `body`/timestamps).
 * @param i - Normalized issue from the GitHub client
 * @returns Compact `{ number, title, state, user, labels, assignees, html_url }` summary
 */
function issueSummary(i: GitHubIssue): {
  number: number;
  title: string;
  state: 'open' | 'closed';
  user: string;
  labels: string[];
  assignees: string[];
  html_url: string;
} {
  return {
    number: i.number,
    title: i.title,
    state: i.state,
    user: i.user.login,
    labels: i.labels.map((l) => l.name),
    assignees: i.assignees.map((a) => a.login),
    html_url: i.html_url,
  };
}

const listIssuesTool: Tool = {
  name: 'listIssues',
  description: 'List issues in a repository. Pull requests are excluded.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.USER_SCOPED]: true,
    [META_KEYS.CURRENT_USER_TOOL]: 'getCurrentUser',
  },
  keywords: ['github', 'issues', 'list', 'bugs', 'tasks', 'tickets'],
  example:
    'const { issues, count } = await github.listIssues({ owner: "octocat", repo: "hello", state: "open" })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      state: {
        type: 'string',
        enum: ['open', 'closed', 'all'],
        description: 'Issue state (default open)',
      },
      labels: { type: 'string', description: 'Comma-separated label names' },
      assignee: {
        type: 'string',
        description:
          "GitHub login, or '*' for any assignee, or 'none' for unassigned. Does NOT accept 'me' — resolve the authenticated user's login via getCurrentUser first, then pass it here.",
      },
      creator: {
        type: 'string',
        description:
          "GitHub login. Does NOT accept 'me' — resolve the authenticated user's login via getCurrentUser first, then pass it here.",
      },
      limit: { type: 'number', description: 'Max results (default 100)' },
    },
    required: ['owner', 'repo'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      issues: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            number: { type: 'number' },
            title: { type: 'string' },
            state: { type: 'string', enum: ['open', 'closed'] },
            user: { type: 'string' },
            labels: { type: 'array', items: { type: 'string' } },
            assignees: { type: 'array', items: { type: 'string' } },
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
      description: 'Minimal: open issues',
      input: { owner: 'octocat', repo: 'hello-world' },
    },
    {
      description: 'Partial: issues by label',
      input: { owner: 'octocat', repo: 'hello-world', labels: 'bug,urgent' },
    },
    {
      description: 'Full: closed issues by a creator with a limit',
      input: {
        owner: 'octocat',
        repo: 'hello-world',
        state: 'closed',
        creator: 'octocat',
        limit: 25,
      },
    },
  ],
};

const getIssueTool: Tool = {
  name: 'getIssue',
  description: 'Get detailed information about a specific issue.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['github', 'issue', 'get', 'show', 'details', 'ticket'],
  example: 'const issue = await github.getIssue({ owner: "octocat", repo: "hello", number: 42 })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      number: { type: 'number', description: 'Issue number' },
    },
    required: ['owner', 'repo', 'number'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      number: { type: 'number' },
      title: { type: 'string' },
      body: { type: 'string' },
      state: { type: 'string', enum: ['open', 'closed'] },
      user: { type: 'object', properties: { login: { type: 'string' } } },
      labels: { type: 'array' },
      assignees: { type: 'array' },
      html_url: { type: 'string' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: get issue details',
      input: { owner: 'octocat', repo: 'hello-world', number: 1 },
    },
    {
      description: 'Partial: get a different issue',
      input: { owner: 'octocat', repo: 'hello-world', number: 123 },
    },
    {
      description: 'Full: get issue by number',
      input: { owner: 'octocat', repo: 'hello-world', number: 4567 },
    },
  ],
};

const createIssueTool: Tool = {
  name: 'createIssue',
  description: 'Create a new issue.',
  annotations: WRITE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: true,
    [META_KEYS.USER_SCOPED]: true,
    [META_KEYS.CURRENT_USER_TOOL]: 'getCurrentUser',
  },
  keywords: ['github', 'issue', 'create', 'new', 'bug', 'ticket'],
  example:
    'const issue = await github.createIssue({ owner: "octocat", repo: "hello", title: "Fix login bug", labels: ["bug"] })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      title: { type: 'string', description: 'Issue title' },
      body: { type: 'string', description: 'Issue body (Markdown)' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Label names to apply' },
      assignees: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Assignee logins. Does NOT accept 'me' — to assign to the authenticated user, resolve their login via getCurrentUser first.",
      },
    },
    required: ['owner', 'repo', 'title'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      number: { type: 'number' },
      title: { type: 'string' },
      state: { type: 'string', enum: ['open', 'closed'] },
      html_url: { type: 'string' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: create an issue with a title only',
      input: { owner: 'octocat', repo: 'hello-world', title: 'Add feature X' },
    },
    {
      description: 'Partial: create an issue with a body and labels',
      input: {
        owner: 'octocat',
        repo: 'hello-world',
        title: 'Bug: login fails',
        body: 'Steps to reproduce...',
        labels: ['bug'],
      },
    },
    {
      description: 'Full: create an issue with body, labels, and assignees',
      input: {
        owner: 'octocat',
        repo: 'hello-world',
        title: 'Improve docs',
        body: 'The README is out of date.',
        labels: ['documentation'],
        assignees: ['octocat'],
      },
    },
  ],
};

const updateIssueTool: Tool = {
  name: 'updateIssue',
  description: 'Update an existing issue.',
  annotations: WRITE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: true,
    [META_KEYS.USER_SCOPED]: true,
    [META_KEYS.CURRENT_USER_TOOL]: 'getCurrentUser',
  },
  keywords: ['github', 'issue', 'update', 'edit', 'modify', 'ticket'],
  example:
    'await github.updateIssue({ owner: "octocat", repo: "hello", number: 42, title: "Updated title", state: "closed" })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      number: { type: 'number', description: 'Issue number' },
      title: { type: 'string', description: 'New issue title' },
      body: { type: 'string', description: 'New issue body (Markdown)' },
      state: { type: 'string', enum: ['open', 'closed'], description: 'New state' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Replacement label names' },
      assignees: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Replacement assignee logins. Does NOT accept 'me' — to assign to the authenticated user, resolve their login via getCurrentUser first.",
      },
    },
    required: ['owner', 'repo', 'number'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      number: { type: 'number' },
      title: { type: 'string' },
      state: { type: 'string', enum: ['open', 'closed'] },
      html_url: { type: 'string' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: update an issue title',
      input: { owner: 'octocat', repo: 'hello-world', number: 1, title: 'New title' },
    },
    {
      description: 'Partial: close an issue',
      input: { owner: 'octocat', repo: 'hello-world', number: 1, state: 'closed' },
    },
    {
      description: 'Full: update title, body, labels, and assignees',
      input: {
        owner: 'octocat',
        repo: 'hello-world',
        number: 1,
        title: 'Refined title',
        body: 'Updated description.',
        labels: ['bug', 'priority'],
        assignees: ['octocat'],
      },
    },
  ],
};

const closeIssueTool: Tool = {
  name: 'closeIssue',
  description: "Closes an issue (shortcut for updateIssue with state 'closed').",
  annotations: WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['github', 'issue', 'close', 'resolve', 'done', 'ticket'],
  example: 'await github.closeIssue({ owner: "octocat", repo: "hello", number: 42 })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      number: { type: 'number', description: 'Issue number' },
    },
    required: ['owner', 'repo', 'number'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      number: { type: 'number' },
      state: { type: 'string', enum: ['open', 'closed'] },
      html_url: { type: 'string' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: close an issue',
      input: { owner: 'octocat', repo: 'hello-world', number: 1 },
    },
    {
      description: 'Partial: close a different issue',
      input: { owner: 'octocat', repo: 'hello-world', number: 123 },
    },
    {
      description: 'Full: close an issue by number',
      input: { owner: 'octocat', repo: 'hello-world', number: 4567 },
    },
  ],
};

/**
 * Builds the issue tool definitions for the GitHub worker.
 * @param client - GitHub client instance (null when the service is not configured)
 */
export function createIssueTools(client: GitHubClient | null): ToolDefinition[] {
  return [
    {
      tool: listIssuesTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, ...options } = params as {
          owner: string;
          repo: string;
          state?: 'open' | 'closed' | 'all';
          labels?: string;
          assignee?: string;
          creator?: string;
          limit?: number;
        };
        const result = await c.listIssues(owner, repo, options);
        return jsonResult({ issues: result.map(issueSummary), count: result.length });
      }),
    },
    {
      tool: getIssueTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, number } = params as { owner: string; repo: string; number: number };
        const result = await c.getIssue(owner, repo, number);
        return jsonResult(result);
      }),
    },
    {
      tool: createIssueTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, ...rest } = params as {
          owner: string;
          repo: string;
          title: string;
          body?: string;
          labels?: string[];
          assignees?: string[];
        };
        const result = await c.createIssue(owner, repo, rest);
        return jsonResult(result);
      }),
    },
    {
      tool: updateIssueTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, number, ...rest } = params as {
          owner: string;
          repo: string;
          number: number;
          title?: string;
          body?: string;
          state?: 'open' | 'closed';
          labels?: string[];
          assignees?: string[];
        };
        const result = await c.updateIssue(owner, repo, number, rest);
        return jsonResult(result);
      }),
    },
    {
      tool: closeIssueTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, number } = params as { owner: string; repo: string; number: number };
        const result = await c.closeIssue(owner, repo, number);
        return jsonResult(result);
      }),
    },
  ];
}
