/**
 * GitHub Repos Domain - Handles repository listing, retrieval, and code search.
 * @module domains/repos
 */

import type { Octokit } from '@octokit/rest';
import type { GitHubRepo } from '../types.js';

/**
 * Client interface for GitHub repository operations.
 * Provides methods to list, retrieve, and search across repositories.
 * @interface ReposClient
 */
export interface ReposClient {
  /**
   * Lists repositories accessible to the authenticated user, or searches repositories when a search term is given.
   * @param {object} [options] - Optional filter and pagination parameters
   * @param {string} [options.search] - If provided, performs a repository search instead of listing the user's repos
   * @param {string} [options.affiliation] - Comma-separated affiliations passed to GitHub (e.g. "owner,collaborator")
   * @param {number} [options.limit] - Maximum number of repositories to return (default 100)
   * @returns {Promise<GitHubRepo[]>} Array of repositories
   */
  list(options?: { search?: string; affiliation?: string; limit?: number }): Promise<GitHubRepo[]>;

  /**
   * Retrieves detailed information about a specific repository.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @returns {Promise<GitHubRepo>} Repository metadata
   */
  get(owner: string, repo: string): Promise<GitHubRepo>;

  /**
   * Searches code across GitHub.
   * @param {string} query - Code search query (GitHub code-search syntax)
   * @param {object} [options] - Optional pagination parameters
   * @param {number} [options.limit] - Maximum number of results to return (default 100)
   * @returns {Promise<Array<{ path: string; repository: string; html_url: string }>>} Array of matches
   */
  searchCode(
    query: string,
    options?: { limit?: number }
  ): Promise<Array<{ path: string; repository: string; html_url: string }>>;
}

/**
 * Creates a repos client instance.
 * @param {Octokit} octokit - Octokit REST instance
 * @returns {ReposClient} Configured repos client
 */
export function createReposClient(octokit: Octokit): ReposClient {
  return {
    async list(options = {}) {
      const limit = options.limit ?? 100;
      if (options.search) {
        const { data } = await octokit.rest.search.repos({
          q: options.search,
          per_page: Math.min(limit, 100),
        });
        const items = (data?.items || []) as Array<Record<string, unknown>>;
        return items.slice(0, limit).map(mapRepo);
      }
      const repos = (await octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
        per_page: Math.min(limit, 100),
        affiliation: options.affiliation,
      })) as Array<Record<string, unknown>>;
      return repos.slice(0, limit).map(mapRepo);
    },

    async get(owner, repo) {
      const { data } = await octokit.rest.repos.get({ owner, repo });
      return mapRepo(data as Record<string, unknown>);
    },

    async searchCode(query, options = {}) {
      const limit = options.limit ?? 100;
      const { data } = await octokit.rest.search.code({
        q: query,
        per_page: Math.min(limit, 100),
      });
      const items = (data?.items || []) as Array<Record<string, unknown>>;
      return items.slice(0, limit).map((i) => {
        const repository = (i.repository || {}) as Record<string, unknown>;
        return {
          path: String(i.path || ''),
          repository: String(repository.full_name || ''),
          html_url: String(i.html_url || ''),
        };
      });
    },
  };
}

/**
 * Normalizes a raw GitHub repository object to the {@link GitHubRepo} shape.
 * @param {unknown} r - Raw repository object from the GitHub API
 * @returns {GitHubRepo} Normalized repository
 */
function mapRepo(r: unknown): GitHubRepo {
  const o = r as Record<string, unknown>;
  const owner = (o.owner || {}) as Record<string, unknown>;
  return {
    id: Number(o.id),
    name: String(o.name || ''),
    full_name: String(o.full_name || ''),
    owner: { login: String(owner.login || '') },
    description: o.description ? String(o.description) : undefined,
    html_url: String(o.html_url || ''),
    default_branch: String(o.default_branch || ''),
    private: Boolean(o.private),
  };
}
