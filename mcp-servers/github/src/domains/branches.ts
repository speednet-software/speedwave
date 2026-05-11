/**
 * GitHub Branches Domain - Handles branch listing, retrieval, creation, deletion,
 * and comparison.
 * @module domains/branches
 */

import type { Octokit } from '@octokit/rest';
import type { GitHubBranch, GitHubCommit, GitHubCommitComparison } from '../types.js';

/**
 * Client interface for GitHub branch operations.
 * @interface BranchesClient
 */
export interface BranchesClient {
  /**
   * Lists branches in a repository.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {object} [options] - Pagination options
   * @param {number} [options.limit] - Maximum number of branches to return (default 100)
   * @returns {Promise<GitHubBranch[]>} Array of branches
   */
  list(owner: string, repo: string, options?: { limit?: number }): Promise<GitHubBranch[]>;

  /**
   * Gets detailed information about a specific branch.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {string} branch - Branch name
   * @returns {Promise<GitHubBranch>} Branch details with latest commit
   */
  get(owner: string, repo: string, branch: string): Promise<GitHubBranch>;

  /**
   * Creates a new branch pointing at the given commit SHA.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {string} branch - New branch name
   * @param {string} sha - Commit SHA the new branch should point at
   * @returns {Promise<{ ref: string; sha: string }>} Created ref name and target SHA
   */
  create(
    owner: string,
    repo: string,
    branch: string,
    sha: string
  ): Promise<{ ref: string; sha: string }>;

  /**
   * Deletes a branch from the repository.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {string} branch - Branch name to delete
   * @returns {Promise<void>}
   */
  delete(owner: string, repo: string, branch: string): Promise<void>;

  /**
   * Compares two refs and returns the commits and diff summary between them.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {string} base - Base ref (branch, tag, or SHA)
   * @param {string} head - Head ref (branch, tag, or SHA)
   * @returns {Promise<GitHubCommitComparison>} Comparison result
   */
  compare(owner: string, repo: string, base: string, head: string): Promise<GitHubCommitComparison>;
}

/**
 * Creates a branches client instance.
 * @param {Octokit} octokit - Octokit REST instance
 * @returns {BranchesClient} Configured branches client
 */
export function createBranchesClient(octokit: Octokit): BranchesClient {
  return {
    async list(owner, repo, options = {}) {
      const limit = options.limit ?? 100;
      const items = (await octokit.paginate(octokit.rest.repos.listBranches, {
        owner,
        repo,
        per_page: Math.min(limit, 100),
      })) as Array<Record<string, unknown>>;
      return items.slice(0, limit).map(mapBranch);
    },

    async get(owner, repo, branch) {
      const { data } = await octokit.rest.repos.getBranch({ owner, repo, branch });
      return mapBranch(data as Record<string, unknown>);
    },

    async create(owner, repo, branch, sha) {
      const { data } = await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branch}`,
        sha,
      });
      const o = data as Record<string, unknown>;
      const object = (o.object || {}) as Record<string, unknown>;
      return { ref: String(o.ref || ''), sha: String(object.sha || '') };
    },

    async delete(owner, repo, branch) {
      await octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${branch}` });
    },

    async compare(owner, repo, base, head) {
      const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${base}...${head}`,
      });
      const o = data as Record<string, unknown>;
      return {
        ahead_by: Number(o.ahead_by || 0),
        behind_by: Number(o.behind_by || 0),
        total_commits: Number(o.total_commits || 0),
        status: String(o.status || ''),
        commits: Array.isArray(o.commits) ? (o.commits as unknown[]).map(mapCommit) : [],
      };
    },
  };
}

/**
 * Normalizes a raw GitHub branch object to the {@link GitHubBranch} shape.
 * @param {unknown} b - Raw branch object from the GitHub API
 * @returns {GitHubBranch} Normalized branch
 */
function mapBranch(b: unknown): GitHubBranch {
  const o = b as Record<string, unknown>;
  const commit = (o.commit || {}) as Record<string, unknown>;
  return {
    name: String(o.name || ''),
    commit: { sha: String(commit.sha || '') },
    protected: Boolean(o.protected),
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
