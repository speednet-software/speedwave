/**
 * GitLab Commits Domain - Handles commit operations including listing,
 * searching, and retrieving diffs
 * @module domains/commits
 */

import { Gitlab } from '@gitbeaker/rest';
import type { GitLabCommit } from '../types.js';

/**
 * Client interface for GitLab commit operations.
 * Provides methods to list, search, and inspect commits.
 * @interface CommitsClient
 */
export interface CommitsClient {
  /**
   * Lists commits on a specific branch.
   * @param {string | number} projectId - Project ID or path
   * @param {string} branch - Branch name
   * @param {number} [limit=20] - Maximum number of commits to return
   * @returns {Promise<GitLabCommit[]>} Array of commits
   */
  listBranch(projectId: string | number, branch: string, limit?: number): Promise<GitLabCommit[]>;

  /**
   * Gets the diff for a specific commit showing all file changes.
   * @param {string | number} projectId - Project ID or path
   * @param {string} commitSha - Full or short commit SHA
   * @returns {Promise<unknown>} Commit diff with file changes
   */
  getDiff(projectId: string | number, commitSha: string): Promise<unknown>;

  /**
   * Lists commits with optional filtering by date range, path, or branch.
   * @param {string | number} projectId - Project ID or path
   * @param {Object} [options] - Optional filter parameters
   * @param {string} [options.ref] - Branch or tag name
   * @param {string} [options.since] - Only commits after this date (ISO 8601)
   * @param {string} [options.until] - Only commits before this date (ISO 8601)
   * @param {string} [options.path] - Only commits affecting this file path
   * @param {number} [options.limit=20] - Maximum number of results
   * @returns {Promise<GitLabCommit[]>} Array of commits matching filters
   */
  list(
    projectId: string | number,
    options?: { ref?: string; since?: string; until?: string; path?: string; limit?: number }
  ): Promise<GitLabCommit[]>;

  /**
   * Searches commits by message text (client-side filtering).
   * @param {string | number} projectId - Project ID or path
   * @param {string} query - Search text to find in commit messages
   * @param {Object} [options] - Optional search parameters
   * @param {string} [options.ref] - Branch or tag name to search in
   * @param {number} [options.limit=20] - Maximum number of results
   * @returns {Promise<GitLabCommit[]>} Array of matching commits
   */
  search(
    projectId: string | number,
    query: string,
    options?: { ref?: string; limit?: number }
  ): Promise<GitLabCommit[]>;
}

/**
 * Maps GitLab API commit response to standardized GitLabCommit type.
 * Handles both camelCase and snake_case field names from API.
 * @param {unknown} c - Raw commit object from GitLab API
 * @returns {GitLabCommit} Normalized commit object
 */
function mapCommit(c: unknown): GitLabCommit {
  const commit = c as Record<string, unknown>;
  return {
    id: String(commit.id),
    short_id: String(commit.shortId || commit['short_id'] || ''),
    title: String(commit.title),
    message: String(commit.message),
    author_name: String(commit.authorName || commit['author_name'] || ''),
    author_email: String(commit.authorEmail || commit['author_email'] || ''),
    created_at: String(commit.createdAt || commit['created_at'] || ''),
  };
}

/**
 * Creates a commits client instance with the given GitLab SDK instance.
 * @param {InstanceType<typeof Gitlab>} gitlab - GitBeaker SDK instance
 * @returns {CommitsClient} Configured commits client
 */
export function createCommitsClient(gitlab: InstanceType<typeof Gitlab>): CommitsClient {
  return {
    async listBranch(projectId, branch, limit = 20) {
      const commits = await gitlab.Commits.all(projectId, {
        refName: branch,
        perPage: limit,
      });

      // Take only first page
      const limited = commits.slice(0, limit);

      return limited.map(mapCommit);
    },

    async getDiff(projectId, commitSha) {
      return await gitlab.Commits.showDiff(projectId, commitSha);
    },

    async list(projectId, options = {}) {
      const commits = await gitlab.Commits.all(projectId, {
        refName: options.ref,
        since: options.since,
        until: options.until,
        path: options.path,
        perPage: options.limit || 20,
      });

      return commits.slice(0, options.limit || 20).map(mapCommit);
    },

    async search(projectId, query, options = {}) {
      // GitLab API doesn't have direct commit search, so we fetch and filter
      const commits = await gitlab.Commits.all(projectId, {
        refName: options.ref,
        perPage: 100, // Fetch more to search through
      });

      const filtered = commits.filter((c) =>
        String(c.message || c.title || '')
          .toLowerCase()
          .includes(query.toLowerCase())
      );

      return filtered.slice(0, options.limit || 20).map(mapCommit);
    },
  };
}
