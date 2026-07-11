/**
 * Tests for GitHub PR Review Tools
 *
 * Coverage: listPrCommits, listPrReviews, createPrReview, listPrComments,
 *           createPrComment, createPrReviewComment (6 tools)
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { notConfiguredMessage, META_KEYS } from '@speedwave/mcp-shared';
import { createPrReviewTools } from './pr-review-tools.js';
import { createToolDefinitions } from './index.js';
import type { GitHubClient } from '../client.js';

type MockClient = {
  listPrCommits: Mock;
  listPrReviews: Mock;
  createPrReview: Mock;
  listPrComments: Mock;
  createPrComment: Mock;
  createPrReviewComment: Mock;
};

function createMockClient(): MockClient {
  return {
    listPrCommits: vi.fn(),
    listPrReviews: vi.fn(),
    createPrReview: vi.fn(),
    listPrComments: vi.fn(),
    createPrComment: vi.fn(),
    createPrReviewComment: vi.fn(),
  };
}

const NOT_CONFIGURED = {
  content: [{ type: 'text', text: `Error: ${notConfiguredMessage('GitHub')}` }],
  isError: true,
};

const ALL_TOOL_NAMES = [
  'listPrCommits',
  'listPrReviews',
  'createPrReview',
  'listPrComments',
  'createPrComment',
  'createPrReviewComment',
];

function makeCommit(overrides: Record<string, unknown> = {}) {
  return {
    sha: 'abc123',
    commit: {
      message: 'Initial commit',
      author: { name: 'Octo Cat', email: 'octo@example.com', date: '2024-01-01T00:00:00Z' },
    },
    html_url: 'https://github.com/octocat/hello-world/commit/abc123',
    ...overrides,
  };
}

function makeReview(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    user: { login: 'octocat' },
    state: 'APPROVED',
    body: 'LGTM',
    submitted_at: '2024-01-01T00:00:00Z',
    html_url: 'https://github.com/octocat/hello-world/pull/42#pullrequestreview-1',
    ...overrides,
  };
}

function makeComment(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    user: { login: 'octocat' },
    body: 'Nice work',
    created_at: '2024-01-01T00:00:00Z',
    html_url: 'https://github.com/octocat/hello-world/pull/42#issuecomment-1',
    ...overrides,
  };
}

function makeReviewComment(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    user: { login: 'octocat' },
    body: 'Rename this',
    path: 'src/index.ts',
    line: 10,
    created_at: '2024-01-01T00:00:00Z',
    html_url: 'https://github.com/octocat/hello-world/pull/42#discussion_r1',
    ...overrides,
  };
}

describe('PR Review Tools', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
  });

  describe('unconfigured client', () => {
    it('returns 6 tools when client is null', () => {
      const tools = createPrReviewTools(null);
      expect(tools).toHaveLength(6);
      expect(tools.map((t) => t.tool.name)).toEqual(ALL_TOOL_NAMES);
    });

    it.each([
      ['listPrCommits', { owner: 'o', repo: 'r', number: 1 }],
      ['listPrReviews', { owner: 'o', repo: 'r', number: 1 }],
      ['createPrReview', { owner: 'o', repo: 'r', number: 1, event: 'APPROVE' }],
      ['listPrComments', { owner: 'o', repo: 'r', number: 1 }],
      ['createPrComment', { owner: 'o', repo: 'r', number: 1, body: 'hi' }],
      [
        'createPrReviewComment',
        { owner: 'o', repo: 'r', number: 1, body: 'b', commit_id: 'c', path: 'p', line: 1 },
      ],
    ])('returns error for %s when client is null', async (name, args) => {
      const tools = createPrReviewTools(null);
      const handler = tools.find((t) => t.tool.name === name)?.handler;
      expect(handler).toBeDefined();
      expect(await handler!(args)).toEqual(NOT_CONFIGURED);
    });
  });

  describe('tool definitions', () => {
    it('returns 6 tools, all deferLoading: true', () => {
      const tools = createPrReviewTools(mockClient as unknown as GitHubClient);
      expect(tools.map((t) => t.tool.name)).toEqual(ALL_TOOL_NAMES);
      for (const t of tools) {
        expect(t.tool._meta?.[META_KEYS.DEFER_LOADING]).toBe(true);
      }
    });

    it('create* tools are writes, list* tools are read-only', () => {
      const tools = createPrReviewTools(mockClient as unknown as GitHubClient);
      for (const name of ['createPrReview', 'createPrComment', 'createPrReviewComment']) {
        expect(tools.find((t) => t.tool.name === name)?.tool.annotations).toMatchObject({
          readOnlyHint: false,
          destructiveHint: false,
        });
      }
      for (const name of ['listPrCommits', 'listPrReviews', 'listPrComments']) {
        expect(tools.find((t) => t.tool.name === name)?.tool.annotations).toMatchObject({
          readOnlyHint: true,
        });
      }
    });
  });

  describe('listPrCommits', () => {
    it('maps commits and counts them', async () => {
      const commits = [
        makeCommit(),
        makeCommit({
          sha: 'def456',
          commit: { message: 'Second', author: { name: 'Jane' } },
          html_url: 'https://github.com/octocat/hello-world/commit/def456',
        }),
      ];
      mockClient.listPrCommits.mockResolvedValue(commits);

      const tools = createPrReviewTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'listPrCommits')?.handler;
      const result = await handler!({ owner: 'octocat', repo: 'hello-world', number: 42 });

      const expected = {
        commits: [
          {
            sha: 'abc123',
            message: 'Initial commit',
            author: 'Octo Cat',
            html_url: 'https://github.com/octocat/hello-world/commit/abc123',
          },
          {
            sha: 'def456',
            message: 'Second',
            author: 'Jane',
            html_url: 'https://github.com/octocat/hello-world/commit/def456',
          },
        ],
        count: 2,
      };
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(expected, null, 2) }],
      });
      expect(mockClient.listPrCommits).toHaveBeenCalledWith('octocat', 'hello-world', 42, {});
    });

    it('handles a commit with no author', async () => {
      const commits = [{ sha: 's', commit: { message: 'm' }, html_url: 'u' }];
      mockClient.listPrCommits.mockResolvedValue(commits);

      const tools = createPrReviewTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'listPrCommits')?.handler;
      const result = await handler!({ owner: 'o', repo: 'r', number: 1 });

      const expected = {
        commits: [{ sha: 's', message: 'm', author: undefined, html_url: 'u' }],
        count: 1,
      };
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(expected, null, 2) }],
      });
    });

    it('forwards limit', async () => {
      mockClient.listPrCommits.mockResolvedValue([]);

      const tools = createPrReviewTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'listPrCommits')?.handler;
      await handler!({ owner: 'o', repo: 'r', number: 1, limit: 5 });

      expect(mockClient.listPrCommits).toHaveBeenCalledWith('o', 'r', 1, { limit: 5 });
    });

    it('returns error on failure', async () => {
      mockClient.listPrCommits.mockRejectedValue(new Error('Not Found'));

      const tools = createPrReviewTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'listPrCommits')?.handler;
      const result = await handler!({ owner: 'o', repo: 'r', number: 1 });

      expect(result).toMatchObject({ isError: true });
    });
  });

  describe('listPrReviews', () => {
    it('returns reviews and count', async () => {
      const reviews = [
        makeReview(),
        makeReview({ id: 2, state: 'CHANGES_REQUESTED', body: 'fix' }),
      ];
      mockClient.listPrReviews.mockResolvedValue(reviews);

      const tools = createPrReviewTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'listPrReviews')?.handler;
      const result = await handler!({ owner: 'octocat', repo: 'hello-world', number: 42 });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify({ reviews, count: 2 }, null, 2) }],
      });
      expect(mockClient.listPrReviews).toHaveBeenCalledWith('octocat', 'hello-world', 42, {});
    });

    it('forwards limit and returns empty list', async () => {
      mockClient.listPrReviews.mockResolvedValue([]);

      const tools = createPrReviewTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'listPrReviews')?.handler;
      const result = await handler!({ owner: 'o', repo: 'r', number: 1, limit: 3 });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify({ reviews: [], count: 0 }, null, 2) }],
      });
      expect(mockClient.listPrReviews).toHaveBeenCalledWith('o', 'r', 1, { limit: 3 });
    });

    it('returns error on failure', async () => {
      mockClient.listPrReviews.mockRejectedValue(new Error('Forbidden'));

      const tools = createPrReviewTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'listPrReviews')?.handler;
      const result = await handler!({ owner: 'o', repo: 'r', number: 1 });

      expect(result).toMatchObject({ isError: true });
    });
  });

  describe('createPrReview', () => {
    it('approves with body and no inline comments', async () => {
      const review = makeReview();
      mockClient.createPrReview.mockResolvedValue(review);

      const tools = createPrReviewTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'createPrReview')?.handler;
      const result = await handler!({
        owner: 'octocat',
        repo: 'hello-world',
        number: 42,
        event: 'APPROVE',
        body: 'LGTM',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(review, null, 2) }],
      });
      expect(mockClient.createPrReview).toHaveBeenCalledWith('octocat', 'hello-world', 42, {
        event: 'APPROVE',
        body: 'LGTM',
      });
    });

    it('forwards inline comments and a REQUEST_CHANGES event', async () => {
      const review = makeReview({ state: 'CHANGES_REQUESTED' });
      mockClient.createPrReview.mockResolvedValue(review);

      const comments = [{ path: 'src/index.ts', line: 12, body: 'extract this' }];
      const tools = createPrReviewTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'createPrReview')?.handler;
      await handler!({
        owner: 'o',
        repo: 'r',
        number: 1,
        event: 'REQUEST_CHANGES',
        body: 'see notes',
        comments,
      });

      expect(mockClient.createPrReview).toHaveBeenCalledWith('o', 'r', 1, {
        event: 'REQUEST_CHANGES',
        body: 'see notes',
        comments,
      });
    });

    it('works with only the required event (no body)', async () => {
      mockClient.createPrReview.mockResolvedValue(
        makeReview({ state: 'COMMENTED', body: undefined })
      );

      const tools = createPrReviewTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'createPrReview')?.handler;
      await handler!({ owner: 'o', repo: 'r', number: 1, event: 'COMMENT' });

      expect(mockClient.createPrReview).toHaveBeenCalledWith('o', 'r', 1, { event: 'COMMENT' });
    });

    it('returns error on failure', async () => {
      mockClient.createPrReview.mockRejectedValue(new Error('Validation Failed'));

      const tools = createPrReviewTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'createPrReview')?.handler;
      const result = await handler!({ owner: 'o', repo: 'r', number: 1, event: 'APPROVE' });

      expect(result).toMatchObject({ isError: true });
    });
  });

  describe('listPrComments', () => {
    it('returns comments and count', async () => {
      const comments = [makeComment(), makeComment({ id: 2, body: 'thanks' })];
      mockClient.listPrComments.mockResolvedValue(comments);

      const tools = createPrReviewTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'listPrComments')?.handler;
      const result = await handler!({ owner: 'octocat', repo: 'hello-world', number: 42 });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify({ comments, count: 2 }, null, 2) }],
      });
      expect(mockClient.listPrComments).toHaveBeenCalledWith('octocat', 'hello-world', 42, {});
    });

    it('forwards limit and returns empty list', async () => {
      mockClient.listPrComments.mockResolvedValue([]);

      const tools = createPrReviewTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'listPrComments')?.handler;
      const result = await handler!({ owner: 'o', repo: 'r', number: 1, limit: 20 });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify({ comments: [], count: 0 }, null, 2) }],
      });
      expect(mockClient.listPrComments).toHaveBeenCalledWith('o', 'r', 1, { limit: 20 });
    });

    it('returns error on failure', async () => {
      mockClient.listPrComments.mockRejectedValue(new Error('Not Found'));

      const tools = createPrReviewTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'listPrComments')?.handler;
      const result = await handler!({ owner: 'o', repo: 'r', number: 1 });

      expect(result).toMatchObject({ isError: true });
    });
  });

  describe('createPrComment', () => {
    it('creates a comment and returns it', async () => {
      const comment = makeComment({ body: 'Looks good' });
      mockClient.createPrComment.mockResolvedValue(comment);

      const tools = createPrReviewTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'createPrComment')?.handler;
      const result = await handler!({
        owner: 'octocat',
        repo: 'hello-world',
        number: 42,
        body: 'Looks good',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(comment, null, 2) }],
      });
      expect(mockClient.createPrComment).toHaveBeenCalledWith(
        'octocat',
        'hello-world',
        42,
        'Looks good'
      );
    });

    it('handles an empty body string', async () => {
      const comment = makeComment({ body: '' });
      mockClient.createPrComment.mockResolvedValue(comment);

      const tools = createPrReviewTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'createPrComment')?.handler;
      await handler!({ owner: 'o', repo: 'r', number: 1, body: '' });

      expect(mockClient.createPrComment).toHaveBeenCalledWith('o', 'r', 1, '');
    });

    it('returns error on failure', async () => {
      mockClient.createPrComment.mockRejectedValue(new Error('Forbidden'));

      const tools = createPrReviewTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'createPrComment')?.handler;
      const result = await handler!({ owner: 'o', repo: 'r', number: 1, body: 'x' });

      expect(result).toMatchObject({ isError: true });
    });
  });

  describe('createPrReviewComment', () => {
    it('creates a line-anchored review comment and returns it', async () => {
      const reviewComment = makeReviewComment();
      mockClient.createPrReviewComment.mockResolvedValue(reviewComment);

      const tools = createPrReviewTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'createPrReviewComment')?.handler;
      const result = await handler!({
        owner: 'octocat',
        repo: 'hello-world',
        number: 42,
        body: 'Rename this',
        commit_id: 'abc123def456',
        path: 'src/index.ts',
        line: 10,
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(reviewComment, null, 2) }],
      });
      expect(mockClient.createPrReviewComment).toHaveBeenCalledWith('octocat', 'hello-world', 42, {
        body: 'Rename this',
        commit_id: 'abc123def456',
        path: 'src/index.ts',
        line: 10,
      });
    });

    it('forgives a string `line` (schema-driven numeric forgiveness at registration)', async () => {
      mockClient.createPrReviewComment.mockResolvedValue(makeReviewComment());

      const tools = createToolDefinitions(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'createPrReviewComment')?.handler;
      await handler!({
        owner: 'octocat',
        repo: 'hello-world',
        number: '#42',
        body: 'b',
        commit_id: 'c',
        path: 'src/index.ts',
        line: '10',
      });

      expect(mockClient.createPrReviewComment).toHaveBeenCalledWith('octocat', 'hello-world', 42, {
        body: 'b',
        commit_id: 'c',
        path: 'src/index.ts',
        line: 10,
      });
    });

    it('returns error on failure', async () => {
      mockClient.createPrReviewComment.mockRejectedValue(new Error('Validation Failed'));

      const tools = createPrReviewTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'createPrReviewComment')?.handler;
      const result = await handler!({
        owner: 'o',
        repo: 'r',
        number: 1,
        body: 'b',
        commit_id: 'c',
        path: 'p',
        line: 1,
      });

      expect(result).toMatchObject({ isError: true });
    });
  });
});
