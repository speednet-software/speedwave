/**
 * PR Review Tools - 6 tools for GitHub pull request reviews and comments
 */

import {
  Tool,
  ToolDefinition,
  jsonResult,
  errorResult,
  notConfiguredMessage,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
} from '@speedwave/mcp-shared';
import { GitHubClient } from '../client.js';
import { withValidation } from './validation.js';

const PR_NUMBER_PROPERTIES = {
  owner: { type: 'string', description: 'Repository owner (user or org)' },
  repo: { type: 'string', description: 'Repository name' },
  number: { type: 'number', description: 'Pull request number' },
};

const listPrCommitsTool: Tool = {
  name: 'listPrCommits',
  description: 'List the commits included in a pull request.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['github', 'pr', 'pull', 'request', 'commits', 'history'],
  example:
    'const { commits, count } = await github.listPrCommits({ owner: "octocat", repo: "hello", number: 42 })',
  inputSchema: {
    type: 'object',
    properties: {
      ...PR_NUMBER_PROPERTIES,
      limit: { type: 'number', description: 'Max results, default 100' },
    },
    required: ['owner', 'repo', 'number'],
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
      description: 'Minimal: list PR commits',
      input: { owner: 'octocat', repo: 'hello-world', number: 1 },
    },
    {
      description: 'Full: list PR commits with a limit',
      input: { owner: 'octocat', repo: 'hello-world', number: 1, limit: 10 },
    },
  ],
};

const listPrReviewsTool: Tool = {
  name: 'listPrReviews',
  description: 'List the reviews submitted on a pull request.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['github', 'pr', 'pull', 'request', 'reviews', 'approvals'],
  example:
    'const { reviews, count } = await github.listPrReviews({ owner: "octocat", repo: "hello", number: 42 })',
  inputSchema: {
    type: 'object',
    properties: {
      ...PR_NUMBER_PROPERTIES,
      limit: { type: 'number', description: 'Max results, default 100' },
    },
    required: ['owner', 'repo', 'number'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      reviews: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            user: { type: 'object', properties: { login: { type: 'string' } } },
            state: { type: 'string' },
            body: { type: 'string' },
            submitted_at: { type: 'string' },
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
      description: 'Minimal: list PR reviews',
      input: { owner: 'octocat', repo: 'hello-world', number: 1 },
    },
    {
      description: 'Full: list PR reviews with a limit',
      input: { owner: 'octocat', repo: 'hello-world', number: 1, limit: 5 },
    },
  ],
};

const createPrReviewTool: Tool = {
  name: 'createPrReview',
  description:
    'Create a review on a pull request (approve, request changes, or comment), optionally with inline line comments.',
  annotations: WRITE_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['github', 'pr', 'pull', 'request', 'review', 'approve', 'request-changes', 'comment'],
  example:
    'await github.createPrReview({ owner: "octocat", repo: "hello", number: 42, event: "APPROVE", body: "LGTM" })',
  inputSchema: {
    type: 'object',
    properties: {
      ...PR_NUMBER_PROPERTIES,
      event: {
        type: 'string',
        enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'],
        description: 'Review action',
      },
      body: { type: 'string', description: 'Review body text (Markdown)' },
      comments: {
        type: 'array',
        description: 'Inline review comments anchored to lines of the diff',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path the comment is attached to' },
            line: { type: 'number', description: 'Line number in the file' },
            body: { type: 'string', description: 'Comment text (Markdown)' },
          },
          required: ['path', 'line', 'body'],
        },
      },
    },
    required: ['owner', 'repo', 'number', 'event'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      id: { type: 'number' },
      user: { type: 'object', properties: { login: { type: 'string' } } },
      state: { type: 'string' },
      body: { type: 'string' },
      submitted_at: { type: 'string' },
      html_url: { type: 'string' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: approve a pull request',
      input: { owner: 'octocat', repo: 'hello-world', number: 1, event: 'APPROVE' },
    },
    {
      description: 'Partial: request changes with a body',
      input: {
        owner: 'octocat',
        repo: 'hello-world',
        number: 1,
        event: 'REQUEST_CHANGES',
        body: 'Please fix the tests',
      },
    },
    {
      description: 'Full: comment review with an inline comment',
      input: {
        owner: 'octocat',
        repo: 'hello-world',
        number: 1,
        event: 'COMMENT',
        body: 'A couple of notes',
        comments: [{ path: 'src/index.ts', line: 12, body: 'extract this to a helper' }],
      },
    },
  ],
};

const listPrCommentsTool: Tool = {
  name: 'listPrComments',
  description: 'General (non-review) comments on a pull request.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['github', 'pr', 'pull', 'request', 'comments', 'discussion'],
  example:
    'const { comments, count } = await github.listPrComments({ owner: "octocat", repo: "hello", number: 42 })',
  inputSchema: {
    type: 'object',
    properties: {
      ...PR_NUMBER_PROPERTIES,
      limit: { type: 'number', description: 'Max results, default 100' },
    },
    required: ['owner', 'repo', 'number'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      comments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            user: { type: 'object', properties: { login: { type: 'string' } } },
            body: { type: 'string' },
            created_at: { type: 'string' },
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
      description: 'Minimal: list PR comments',
      input: { owner: 'octocat', repo: 'hello-world', number: 1 },
    },
    {
      description: 'Full: list PR comments with a limit',
      input: { owner: 'octocat', repo: 'hello-world', number: 1, limit: 20 },
    },
  ],
};

const createPrCommentTool: Tool = {
  name: 'createPrComment',
  description: 'Add a general (non-review) comment to a pull request.',
  annotations: WRITE_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['github', 'pr', 'pull', 'request', 'comment', 'create', 'add'],
  example:
    'await github.createPrComment({ owner: "octocat", repo: "hello", number: 42, body: "Thanks!" })',
  inputSchema: {
    type: 'object',
    properties: {
      ...PR_NUMBER_PROPERTIES,
      body: { type: 'string', description: 'Comment text (Markdown)' },
    },
    required: ['owner', 'repo', 'number', 'body'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      id: { type: 'number' },
      user: { type: 'object', properties: { login: { type: 'string' } } },
      body: { type: 'string' },
      created_at: { type: 'string' },
      html_url: { type: 'string' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Add a comment to a pull request',
      input: { owner: 'octocat', repo: 'hello-world', number: 1, body: 'Looks good' },
    },
  ],
};

const createPrReviewCommentTool: Tool = {
  name: 'createPrReviewComment',
  description: "A review comment anchored to a specific line of a file in a pull request's diff.",
  annotations: WRITE_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['github', 'pr', 'pull', 'request', 'review', 'comment', 'inline', 'line'],
  example:
    'await github.createPrReviewComment({ owner: "octocat", repo: "hello", number: 42, body: "nit", commit_id: "abc123", path: "src/index.ts", line: 10 })',
  inputSchema: {
    type: 'object',
    properties: {
      ...PR_NUMBER_PROPERTIES,
      body: { type: 'string', description: 'Comment text (Markdown)' },
      commit_id: { type: 'string', description: 'SHA of the commit to comment on' },
      path: { type: 'string', description: 'File path the comment is attached to' },
      line: { type: 'number', description: 'Line number in the file' },
    },
    required: ['owner', 'repo', 'number', 'body', 'commit_id', 'path', 'line'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      id: { type: 'number' },
      user: { type: 'object', properties: { login: { type: 'string' } } },
      body: { type: 'string' },
      path: { type: 'string' },
      line: { type: 'number' },
      created_at: { type: 'string' },
      html_url: { type: 'string' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Add a line-anchored review comment',
      input: {
        owner: 'octocat',
        repo: 'hello-world',
        number: 1,
        body: 'consider renaming this',
        commit_id: 'abc123def456',
        path: 'src/index.ts',
        line: 10,
      },
    },
  ],
};

/**
 * Builds the pull request review and comment tool definitions.
 * @param client - GitHub client instance (null when the service is not configured)
 */
export function createPrReviewTools(client: GitHubClient | null): ToolDefinition[] {
  const unconfigured = async () => errorResult(notConfiguredMessage('GitHub'));
  if (!client) {
    return [
      { tool: listPrCommitsTool, handler: unconfigured },
      { tool: listPrReviewsTool, handler: unconfigured },
      { tool: createPrReviewTool, handler: unconfigured },
      { tool: listPrCommentsTool, handler: unconfigured },
      { tool: createPrCommentTool, handler: unconfigured },
      { tool: createPrReviewCommentTool, handler: unconfigured },
    ];
  }

  return [
    {
      tool: listPrCommitsTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, number, ...options } = params as {
          owner: string;
          repo: string;
          number: number;
          limit?: number;
        };
        const result = await c.listPrCommits(owner, repo, number, options);
        return jsonResult({
          commits: result.map((commit) => ({
            sha: commit.sha,
            message: commit.commit.message,
            author: commit.commit.author?.name,
            html_url: commit.html_url,
          })),
          count: result.length,
        });
      }),
    },
    {
      tool: listPrReviewsTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, number, ...options } = params as {
          owner: string;
          repo: string;
          number: number;
          limit?: number;
        };
        const result = await c.listPrReviews(owner, repo, number, options);
        return jsonResult({ reviews: result, count: result.length });
      }),
    },
    {
      tool: createPrReviewTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, number, ...rest } = params as {
          owner: string;
          repo: string;
          number: number;
          event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
          body?: string;
          comments?: Array<{ path: string; line: number; body: string }>;
        };
        const result = await c.createPrReview(owner, repo, number, rest);
        return jsonResult(result);
      }),
    },
    {
      tool: listPrCommentsTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, number, ...options } = params as {
          owner: string;
          repo: string;
          number: number;
          limit?: number;
        };
        const result = await c.listPrComments(owner, repo, number, options);
        return jsonResult({ comments: result, count: result.length });
      }),
    },
    {
      tool: createPrCommentTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, number, body } = params as {
          owner: string;
          repo: string;
          number: number;
          body: string;
        };
        const result = await c.createPrComment(owner, repo, number, body);
        return jsonResult(result);
      }),
    },
    {
      tool: createPrReviewCommentTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, number, ...rest } = params as {
          owner: string;
          repo: string;
          number: number;
          body: string;
          commit_id: string;
          path: string;
          line: number;
        };
        const result = await c.createPrReviewComment(owner, repo, number, rest);
        return jsonResult(result);
      }),
    },
  ];
}
