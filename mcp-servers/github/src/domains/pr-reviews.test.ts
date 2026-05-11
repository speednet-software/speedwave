import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { createPrReviewsClient } from './pr-reviews.js';

function createMockOctokit() {
  return {
    rest: {
      pulls: {
        listReviews: vi.fn(),
        createReview: vi.fn(),
        createReviewComment: vi.fn(),
        listCommits: vi.fn(),
      },
      issues: {
        listComments: vi.fn(),
        createComment: vi.fn(),
      },
    },
    paginate: vi.fn(),
  };
}

describe('PrReviewsClient', () => {
  let mock: ReturnType<typeof createMockOctokit>;
  let client: ReturnType<typeof createPrReviewsClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockOctokit();
    client = createPrReviewsClient(mock as unknown as Octokit);
  });

  describe('listReviews', () => {
    it('lists reviews and maps them', async () => {
      mock.paginate.mockResolvedValue([
        {
          id: 1,
          user: { login: 'reviewer' },
          state: 'APPROVED',
          body: 'LGTM',
          submitted_at: '2024-01-01T00:00:00Z',
          html_url: 'https://github.com/octocat/hello/pull/7#pullrequestreview-1',
        },
        { id: 2, state: 'COMMENTED' },
      ]);

      const result = await client.listReviews('octocat', 'hello', 7);

      expect(mock.paginate).toHaveBeenCalledWith(mock.rest.pulls.listReviews, {
        owner: 'octocat',
        repo: 'hello',
        pull_number: 7,
        per_page: 100,
      });
      expect(result[0]).toEqual({
        id: 1,
        user: { login: 'reviewer' },
        state: 'APPROVED',
        body: 'LGTM',
        submitted_at: '2024-01-01T00:00:00Z',
        html_url: 'https://github.com/octocat/hello/pull/7#pullrequestreview-1',
      });
      expect(result[1]).toEqual({
        id: 2,
        user: { login: '' },
        state: 'COMMENTED',
        body: undefined,
        submitted_at: undefined,
        html_url: '',
      });
    });

    it('truncates to the limit', async () => {
      mock.paginate.mockResolvedValue(
        Array.from({ length: 10 }, (_, i) => ({ id: i, state: 'COMMENTED' }))
      );

      const result = await client.listReviews('octocat', 'hello', 7, { limit: 3 });

      expect(result).toHaveLength(3);
      expect(mock.paginate).toHaveBeenCalledWith(mock.rest.pulls.listReviews, {
        owner: 'octocat',
        repo: 'hello',
        pull_number: 7,
        per_page: 3,
      });
    });
  });

  describe('createReview', () => {
    it('creates a review with inline comments', async () => {
      mock.rest.pulls.createReview.mockResolvedValue({
        data: { id: 10, user: { login: 'reviewer' }, state: 'CHANGES_REQUESTED', html_url: 'u' },
      });

      const result = await client.createReview('octocat', 'hello', 7, {
        body: 'Please fix',
        event: 'REQUEST_CHANGES',
        comments: [{ path: 'a.ts', line: 3, body: 'nit' }],
      });

      expect(mock.rest.pulls.createReview).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        pull_number: 7,
        body: 'Please fix',
        event: 'REQUEST_CHANGES',
        comments: [{ path: 'a.ts', line: 3, body: 'nit' }],
      });
      expect(result).toEqual({
        id: 10,
        user: { login: 'reviewer' },
        state: 'CHANGES_REQUESTED',
        body: undefined,
        submitted_at: undefined,
        html_url: 'u',
      });
    });

    it('propagates API errors', async () => {
      mock.rest.pulls.createReview.mockRejectedValue(new Error('unprocessable'));

      await expect(
        client.createReview('octocat', 'hello', 7, { event: 'APPROVE' })
      ).rejects.toThrow('unprocessable');
    });

    it('normalizes a sparse review response (mapReview defaults — no state)', async () => {
      mock.rest.pulls.createReview.mockResolvedValue({ data: { id: 99 } });

      const result = await client.createReview('octocat', 'hello', 7, { event: 'COMMENT' });

      expect(result).toEqual({
        id: 99,
        user: { login: '' },
        state: '',
        body: undefined,
        submitted_at: undefined,
        html_url: '',
      });
    });
  });

  describe('listComments', () => {
    it('lists general PR comments via the issues endpoint', async () => {
      mock.paginate.mockResolvedValue([
        {
          id: 1,
          user: { login: 'octocat' },
          body: 'A comment',
          created_at: '2024-01-01T00:00:00Z',
          html_url: 'https://github.com/octocat/hello/pull/7#issuecomment-1',
        },
      ]);

      const result = await client.listComments('octocat', 'hello', 7);

      expect(mock.paginate).toHaveBeenCalledWith(mock.rest.issues.listComments, {
        owner: 'octocat',
        repo: 'hello',
        issue_number: 7,
        per_page: 100,
      });
      expect(result[0]).toEqual({
        id: 1,
        user: { login: 'octocat' },
        body: 'A comment',
        created_at: '2024-01-01T00:00:00Z',
        html_url: 'https://github.com/octocat/hello/pull/7#issuecomment-1',
      });
    });

    it('truncates to the limit and defends against missing fields', async () => {
      mock.paginate.mockResolvedValue(Array.from({ length: 5 }, () => ({})));

      const result = await client.listComments('octocat', 'hello', 7, { limit: 2 });

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: NaN,
        user: { login: '' },
        body: '',
        created_at: '',
        html_url: '',
      });
    });
  });

  describe('createComment', () => {
    it('creates a general PR comment', async () => {
      mock.rest.issues.createComment.mockResolvedValue({
        data: { id: 2, user: { login: 'octocat' }, body: 'Hi', created_at: 't', html_url: 'u' },
      });

      const result = await client.createComment('octocat', 'hello', 7, 'Hi');

      expect(mock.rest.issues.createComment).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        issue_number: 7,
        body: 'Hi',
      });
      expect(result).toEqual({
        id: 2,
        user: { login: 'octocat' },
        body: 'Hi',
        created_at: 't',
        html_url: 'u',
      });
    });
  });

  describe('createReviewComment', () => {
    it('creates a line-level review comment', async () => {
      mock.rest.pulls.createReviewComment.mockResolvedValue({
        data: {
          id: 3,
          user: { login: 'reviewer' },
          body: 'nit',
          path: 'a.ts',
          line: 3,
          created_at: 't',
          html_url: 'u',
        },
      });

      const result = await client.createReviewComment('octocat', 'hello', 7, {
        body: 'nit',
        commit_id: 'abc',
        path: 'a.ts',
        line: 3,
      });

      expect(mock.rest.pulls.createReviewComment).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        pull_number: 7,
        body: 'nit',
        commit_id: 'abc',
        path: 'a.ts',
        line: 3,
      });
      expect(result).toEqual({
        id: 3,
        user: { login: 'reviewer' },
        body: 'nit',
        path: 'a.ts',
        line: 3,
        created_at: 't',
        html_url: 'u',
      });
    });

    it('maps a review comment without a line', async () => {
      mock.rest.pulls.createReviewComment.mockResolvedValue({
        data: { id: 4, body: 'x', path: 'a.ts', created_at: 't', html_url: 'u' },
      });

      const result = await client.createReviewComment('octocat', 'hello', 7, {
        body: 'x',
        commit_id: 'abc',
        path: 'a.ts',
        line: 1,
      });

      expect(result.line).toBeUndefined();
      expect(result.user).toEqual({ login: '' });
    });

    it('normalizes a fully sparse review comment (mapReviewComment defaults)', async () => {
      mock.rest.pulls.createReviewComment.mockResolvedValue({ data: { id: 5 } });

      const result = await client.createReviewComment('octocat', 'hello', 7, {
        body: 'x',
        commit_id: 'abc',
        path: 'a.ts',
        line: 1,
      });

      expect(result).toEqual({
        id: 5,
        user: { login: '' },
        body: '',
        path: '',
        line: undefined,
        created_at: '',
        html_url: '',
      });
    });
  });

  describe('listCommits', () => {
    it('lists the commits in a pull request', async () => {
      mock.paginate.mockResolvedValue([
        {
          sha: 'abc',
          commit: {
            message: 'feat: add x',
            author: { name: 'Dev', email: 'dev@example.com', date: '2024-01-01T00:00:00Z' },
          },
          html_url: 'https://github.com/octocat/hello/commit/abc',
        },
      ]);

      const result = await client.listCommits('octocat', 'hello', 7);

      expect(mock.paginate).toHaveBeenCalledWith(mock.rest.pulls.listCommits, {
        owner: 'octocat',
        repo: 'hello',
        pull_number: 7,
        per_page: 100,
      });
      expect(result[0]).toEqual({
        sha: 'abc',
        commit: {
          message: 'feat: add x',
          author: { name: 'Dev', email: 'dev@example.com', date: '2024-01-01T00:00:00Z' },
        },
        html_url: 'https://github.com/octocat/hello/commit/abc',
      });
    });

    it('truncates to the limit and defends against missing nested objects', async () => {
      mock.paginate.mockResolvedValue(Array.from({ length: 5 }, () => ({})));

      const result = await client.listCommits('octocat', 'hello', 7, { limit: 2 });

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        sha: '',
        commit: { message: '', author: { name: '', email: '', date: '' } },
        html_url: '',
      });
    });
  });
});
