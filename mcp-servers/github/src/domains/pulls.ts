/**
 * GitHub Pull Requests Domain - Handles pull request listing, retrieval, creation,
 * merging, updates, and changed-file listing.
 * @module domains/pulls
 */

import type { Octokit } from '@octokit/rest';
import type { GitHubPullRequest } from '../types.js';

/**
 * A single changed file within a pull request.
 * @interface PullRequestFile
 */
export interface PullRequestFile {
  /** File path relative to the repository root */
  filename: string;
  /** Change status: "added", "modified", "removed", "renamed", etc. */
  status: string;
  /** Number of lines added */
  additions: number;
  /** Number of lines removed */
  deletions: number;
  /** Total number of changed lines */
  changes: number;
  /** Unified diff hunk for this file (omitted for binary or very large files) */
  patch?: string;
}

/**
 * Client interface for GitHub pull request operations.
 * @interface PullsClient
 */
export interface PullsClient {
  /**
   * Lists pull requests in a repository with optional filters.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {object} [options] - Optional filter and pagination parameters
   * @param {'open' | 'closed' | 'all'} [options.state] - Filter by state (default "open")
   * @param {string} [options.head] - Filter by head ref (e.g. "user:branch")
   * @param {string} [options.base] - Filter by base branch name
   * @param {number} [options.limit] - Maximum number of PRs to return (default 100)
   * @returns {Promise<GitHubPullRequest[]>} Array of pull requests
   */
  list(
    owner: string,
    repo: string,
    options?: { state?: 'open' | 'closed' | 'all'; head?: string; base?: string; limit?: number }
  ): Promise<GitHubPullRequest[]>;

  /**
   * Gets detailed information about a specific pull request.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {number} number - Pull request number
   * @returns {Promise<GitHubPullRequest>} Pull request details
   */
  get(owner: string, repo: string, number: number): Promise<GitHubPullRequest>;

  /**
   * Creates a new pull request.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {object} params - Pull request creation parameters
   * @param {string} params.title - PR title
   * @param {string} params.head - Head ref (the branch with the changes)
   * @param {string} params.base - Base branch the changes should be merged into
   * @param {string} [params.body] - Optional PR description (Markdown)
   * @param {boolean} [params.draft] - Whether to create the PR as a draft
   * @returns {Promise<GitHubPullRequest>} Created pull request
   */
  create(
    owner: string,
    repo: string,
    params: { title: string; head: string; base: string; body?: string; draft?: boolean }
  ): Promise<GitHubPullRequest>;

  /**
   * Merges a pull request.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {number} number - Pull request number
   * @param {object} [options] - Merge options
   * @param {'merge' | 'squash' | 'rebase'} [options.merge_method] - Merge strategy (default "merge")
   * @param {string} [options.commit_title] - Optional commit title for the merge commit
   * @returns {Promise<{ merged: boolean; sha: string; message: string }>} Merge result
   */
  merge(
    owner: string,
    repo: string,
    number: number,
    options?: { merge_method?: 'merge' | 'squash' | 'rebase'; commit_title?: string }
  ): Promise<{ merged: boolean; sha: string; message: string }>;

  /**
   * Updates properties of an existing pull request.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {number} number - Pull request number
   * @param {object} params - Update parameters
   * @param {string} [params.title] - New PR title
   * @param {string} [params.body] - New PR description (Markdown)
   * @param {'open' | 'closed'} [params.state] - New state
   * @param {string} [params.base] - New base branch
   * @returns {Promise<GitHubPullRequest>} Updated pull request
   */
  update(
    owner: string,
    repo: string,
    number: number,
    params: { title?: string; body?: string; state?: 'open' | 'closed'; base?: string }
  ): Promise<GitHubPullRequest>;

  /**
   * Lists the files changed in a pull request with per-file stats and patches.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {number} number - Pull request number
   * @param {object} [options] - Pagination options
   * @param {number} [options.limit] - Maximum number of files to return (default 100)
   * @returns {Promise<PullRequestFile[]>} Array of changed files
   */
  listFiles(
    owner: string,
    repo: string,
    number: number,
    options?: { limit?: number }
  ): Promise<PullRequestFile[]>;
}

/**
 * Creates a pulls client instance.
 * @param {Octokit} octokit - Octokit REST instance
 * @returns {PullsClient} Configured pulls client
 */
export function createPullsClient(octokit: Octokit): PullsClient {
  return {
    async list(owner, repo, options = {}) {
      const limit = options.limit ?? 100;
      const prs = (await octokit.paginate(octokit.rest.pulls.list, {
        owner,
        repo,
        state: options.state || 'open',
        head: options.head,
        base: options.base,
        per_page: Math.min(limit, 100),
      })) as Array<Record<string, unknown>>;
      return prs.slice(0, limit).map(mapPullRequest);
    },

    async get(owner, repo, number) {
      const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: number });
      return mapPullRequest(data as Record<string, unknown>);
    },

    async create(owner, repo, params) {
      const { data } = await octokit.rest.pulls.create({
        owner,
        repo,
        title: params.title,
        head: params.head,
        base: params.base,
        body: params.body,
        draft: params.draft,
      });
      return mapPullRequest(data as Record<string, unknown>);
    },

    async merge(owner, repo, number, options = {}) {
      const { data } = await octokit.rest.pulls.merge({
        owner,
        repo,
        pull_number: number,
        merge_method: options.merge_method || 'merge',
        commit_title: options.commit_title,
      });
      const o = data as Record<string, unknown>;
      return {
        merged: Boolean(o.merged),
        sha: String(o.sha || ''),
        message: String(o.message || ''),
      };
    },

    async update(owner, repo, number, params) {
      const { data } = await octokit.rest.pulls.update({
        owner,
        repo,
        pull_number: number,
        title: params.title,
        body: params.body,
        state: params.state,
        base: params.base,
      });
      return mapPullRequest(data as Record<string, unknown>);
    },

    async listFiles(owner, repo, number, options = {}) {
      const limit = options.limit ?? 100;
      const files = (await octokit.paginate(octokit.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: number,
        per_page: Math.min(limit, 100),
      })) as Array<Record<string, unknown>>;
      return files.slice(0, limit).map((f) => ({
        filename: String(f.filename || ''),
        status: String(f.status || ''),
        additions: Number(f.additions || 0),
        deletions: Number(f.deletions || 0),
        changes: Number(f.changes || 0),
        patch: f.patch ? String(f.patch) : undefined,
      }));
    },
  };
}

/**
 * Normalizes a raw GitHub pull request object to the {@link GitHubPullRequest} shape.
 * @param {unknown} pr - Raw pull request object from the GitHub API
 * @returns {GitHubPullRequest} Normalized pull request
 */
function mapPullRequest(pr: unknown): GitHubPullRequest {
  const o = pr as Record<string, unknown>;
  const head = (o.head || {}) as Record<string, unknown>;
  const base = (o.base || {}) as Record<string, unknown>;
  const user = (o.user || {}) as Record<string, unknown>;
  return {
    number: Number(o.number),
    title: String(o.title || ''),
    body: o.body ? String(o.body) : undefined,
    state: String(o.state || 'open') as 'open' | 'closed',
    merged: o.merged !== undefined ? Boolean(o.merged) : undefined,
    head: { ref: String(head.ref || ''), sha: String(head.sha || '') },
    base: { ref: String(base.ref || '') },
    user: { login: String(user.login || '') },
    html_url: String(o.html_url || ''),
    created_at: String(o.created_at || ''),
    updated_at: String(o.updated_at || ''),
    draft: o.draft !== undefined ? Boolean(o.draft) : undefined,
  };
}
