/**
 * GitHub PR Review Domain - Handles pull request reviews, review comments,
 * general PR comments, and PR commit listing.
 * @module domains/pr-reviews
 */

import type { Octokit } from '@octokit/rest';
import type { GitHubReview, GitHubComment, GitHubReviewComment, GitHubCommit } from '../types.js';

/**
 * Client interface for GitHub pull request review operations.
 * @interface PrReviewsClient
 */
export interface PrReviewsClient {
  /**
   * Lists reviews submitted on a pull request.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {number} number - Pull request number
   * @param {object} [options] - Pagination options
   * @param {number} [options.limit] - Maximum number of reviews to return (default 100)
   * @returns {Promise<GitHubReview[]>} Array of reviews
   */
  listReviews(
    owner: string,
    repo: string,
    number: number,
    options?: { limit?: number }
  ): Promise<GitHubReview[]>;

  /**
   * Creates a review on a pull request (approve, request changes, or comment).
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {number} number - Pull request number
   * @param {object} params - Review parameters
   * @param {string} [params.body] - Optional review summary text (Markdown)
   * @param {'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'} params.event - Review action
   * @param {Array<{ path: string; line: number; body: string }>} [params.comments] - Optional inline review comments
   * @returns {Promise<GitHubReview>} Created review
   */
  createReview(
    owner: string,
    repo: string,
    number: number,
    params: {
      body?: string;
      event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
      comments?: Array<{ path: string; line: number; body: string }>;
    }
  ): Promise<GitHubReview>;

  /**
   * Lists general (issue-style) comments on a pull request.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {number} number - Pull request number
   * @param {object} [options] - Pagination options
   * @param {number} [options.limit] - Maximum number of comments to return (default 100)
   * @returns {Promise<GitHubComment[]>} Array of comments
   */
  listComments(
    owner: string,
    repo: string,
    number: number,
    options?: { limit?: number }
  ): Promise<GitHubComment[]>;

  /**
   * Creates a general (issue-style) comment on a pull request.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {number} number - Pull request number
   * @param {string} body - Comment text (Markdown)
   * @returns {Promise<GitHubComment>} Created comment
   */
  createComment(owner: string, repo: string, number: number, body: string): Promise<GitHubComment>;

  /**
   * Creates a review comment attached to a specific line of a pull request diff.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {number} number - Pull request number
   * @param {object} params - Review comment parameters
   * @param {string} params.body - Comment text (Markdown)
   * @param {string} params.commit_id - SHA of the commit the comment applies to
   * @param {string} params.path - File path the comment is attached to
   * @param {number} params.line - Line number in the file the comment refers to
   * @returns {Promise<GitHubReviewComment>} Created review comment
   */
  createReviewComment(
    owner: string,
    repo: string,
    number: number,
    params: { body: string; commit_id: string; path: string; line: number }
  ): Promise<GitHubReviewComment>;

  /**
   * Lists the commits included in a pull request.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {number} number - Pull request number
   * @param {object} [options] - Pagination options
   * @param {number} [options.limit] - Maximum number of commits to return (default 100)
   * @returns {Promise<GitHubCommit[]>} Array of commits
   */
  listCommits(
    owner: string,
    repo: string,
    number: number,
    options?: { limit?: number }
  ): Promise<GitHubCommit[]>;
}

/**
 * Creates a PR reviews client instance.
 * @param {Octokit} octokit - Octokit REST instance
 * @returns {PrReviewsClient} Configured PR reviews client
 */
export function createPrReviewsClient(octokit: Octokit): PrReviewsClient {
  return {
    async listReviews(owner, repo, number, options = {}) {
      const limit = options.limit ?? 100;
      const items = (await octokit.paginate(octokit.rest.pulls.listReviews, {
        owner,
        repo,
        pull_number: number,
        per_page: Math.min(limit, 100),
      })) as Array<Record<string, unknown>>;
      return items.slice(0, limit).map(mapReview);
    },

    async createReview(owner, repo, number, params) {
      const { data } = await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: number,
        body: params.body,
        event: params.event,
        comments: params.comments,
      });
      return mapReview(data as Record<string, unknown>);
    },

    async listComments(owner, repo, number, options = {}) {
      const limit = options.limit ?? 100;
      const items = (await octokit.paginate(octokit.rest.issues.listComments, {
        owner,
        repo,
        issue_number: number,
        per_page: Math.min(limit, 100),
      })) as Array<Record<string, unknown>>;
      return items.slice(0, limit).map(mapComment);
    },

    async createComment(owner, repo, number, body) {
      const { data } = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: number,
        body,
      });
      return mapComment(data as Record<string, unknown>);
    },

    async createReviewComment(owner, repo, number, params) {
      const { data } = await octokit.rest.pulls.createReviewComment({
        owner,
        repo,
        pull_number: number,
        body: params.body,
        commit_id: params.commit_id,
        path: params.path,
        line: params.line,
      });
      return mapReviewComment(data as Record<string, unknown>);
    },

    async listCommits(owner, repo, number, options = {}) {
      const limit = options.limit ?? 100;
      const items = (await octokit.paginate(octokit.rest.pulls.listCommits, {
        owner,
        repo,
        pull_number: number,
        per_page: Math.min(limit, 100),
      })) as Array<Record<string, unknown>>;
      return items.slice(0, limit).map(mapCommit);
    },
  };
}

/**
 * Normalizes a raw GitHub review object to the {@link GitHubReview} shape.
 * @param {unknown} r - Raw review object from the GitHub API
 * @returns {GitHubReview} Normalized review
 */
function mapReview(r: unknown): GitHubReview {
  const o = r as Record<string, unknown>;
  const user = (o.user || {}) as Record<string, unknown>;
  return {
    id: Number(o.id),
    user: { login: String(user.login || '') },
    state: String(o.state || ''),
    body: o.body ? String(o.body) : undefined,
    submitted_at: o.submitted_at ? String(o.submitted_at) : undefined,
    html_url: String(o.html_url || ''),
  };
}

/**
 * Normalizes a raw GitHub issue/PR comment object to the {@link GitHubComment} shape.
 * @param {unknown} c - Raw comment object from the GitHub API
 * @returns {GitHubComment} Normalized comment
 */
function mapComment(c: unknown): GitHubComment {
  const o = c as Record<string, unknown>;
  const user = (o.user || {}) as Record<string, unknown>;
  return {
    id: Number(o.id),
    user: { login: String(user.login || '') },
    body: String(o.body || ''),
    created_at: String(o.created_at || ''),
    html_url: String(o.html_url || ''),
  };
}

/**
 * Normalizes a raw GitHub review comment object to the {@link GitHubReviewComment} shape.
 * @param {unknown} c - Raw review comment object from the GitHub API
 * @returns {GitHubReviewComment} Normalized review comment
 */
function mapReviewComment(c: unknown): GitHubReviewComment {
  const o = c as Record<string, unknown>;
  const user = (o.user || {}) as Record<string, unknown>;
  return {
    id: Number(o.id),
    user: { login: String(user.login || '') },
    body: String(o.body || ''),
    path: String(o.path || ''),
    line: o.line !== undefined && o.line !== null ? Number(o.line) : undefined,
    created_at: String(o.created_at || ''),
    html_url: String(o.html_url || ''),
  };
}

/**
 * Normalizes a raw GitHub commit object to the {@link GitHubCommit} shape.
 * @param {unknown} c - Raw commit object from the GitHub API
 * @returns {GitHubCommit} Normalized commit
 */
function mapCommit(c: unknown): GitHubCommit {
  const o = c as Record<string, unknown>;
  const commit = (o.commit || {}) as Record<string, unknown>;
  const author = (commit.author || {}) as Record<string, unknown>;
  return {
    sha: String(o.sha || ''),
    commit: {
      message: String(commit.message || ''),
      author: {
        name: String(author.name || ''),
        email: String(author.email || ''),
        date: String(author.date || ''),
      },
    },
    html_url: String(o.html_url || ''),
  };
}
