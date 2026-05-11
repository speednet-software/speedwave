/**
 * GitHub Commits Domain - Handles commit listing, retrieval, and search.
 * @module domains/commits
 */

import type { Octokit } from '@octokit/rest';
import type { GitHubCommit } from '../types.js';

/**
 * Client interface for GitHub commit operations.
 * @interface CommitsClient
 */
export interface CommitsClient {
  /**
   * Lists commits in a repository with optional filters.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {object} [options] - Optional filter and pagination parameters
   * @param {string} [options.sha] - SHA or branch to start listing commits from
   * @param {string} [options.path] - Only commits affecting this file path
   * @param {string} [options.author] - Filter by commit author (login or email)
   * @param {string} [options.since] - Only commits after this ISO 8601 timestamp
   * @param {string} [options.until] - Only commits before this ISO 8601 timestamp
   * @param {number} [options.limit] - Maximum number of commits to return (default 100)
   * @returns {Promise<GitHubCommit[]>} Array of commits
   */
  list(
    owner: string,
    repo: string,
    options?: {
      sha?: string;
      path?: string;
      author?: string;
      since?: string;
      until?: string;
      limit?: number;
    }
  ): Promise<GitHubCommit[]>;

  /**
   * Gets detailed information about a specific commit.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {string} ref - Commit SHA, branch, or tag
   * @returns {Promise<GitHubCommit>} Commit details
   */
  get(owner: string, repo: string, ref: string): Promise<GitHubCommit>;

  /**
   * Searches commits across GitHub.
   * @param {string} query - Commit search query (GitHub commit-search syntax)
   * @param {object} [options] - Pagination options
   * @param {number} [options.limit] - Maximum number of results to return (default 100)
   * @returns {Promise<GitHubCommit[]>} Array of matching commits
   */
  search(query: string, options?: { limit?: number }): Promise<GitHubCommit[]>;
}

/**
 * Creates a commits client instance.
 * @param {Octokit} octokit - Octokit REST instance
 * @returns {CommitsClient} Configured commits client
 */
export function createCommitsClient(octokit: Octokit): CommitsClient {
  return {
    async list(owner, repo, options = {}) {
      const limit = options.limit ?? 100;
      const items = (await octokit.paginate(octokit.rest.repos.listCommits, {
        owner,
        repo,
        sha: options.sha,
        path: options.path,
        author: options.author,
        since: options.since,
        until: options.until,
        per_page: Math.min(limit, 100),
      })) as Array<Record<string, unknown>>;
      return items.slice(0, limit).map(mapCommit);
    },

    async get(owner, repo, ref) {
      const { data } = await octokit.rest.repos.getCommit({ owner, repo, ref });
      return mapCommit(data as Record<string, unknown>);
    },

    async search(query, options = {}) {
      const limit = options.limit ?? 100;
      const { data } = await octokit.rest.search.commits({
        q: query,
        per_page: Math.min(limit, 100),
      });
      const items = (data?.items || []) as Array<Record<string, unknown>>;
      return items.slice(0, limit).map(mapCommit);
    },
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
