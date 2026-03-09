/**
 * GitLab Branches Domain - Handles all branch operations including
 * listing, creation, deletion, and comparison
 * @module domains/branches
 */

import { Gitlab } from '@gitbeaker/rest';
import type { GitLabBranch, BranchComparison, GitLabCommit } from '../types.js';

/**
 * Client interface for GitLab branch operations.
 * Provides methods to manage repository branches.
 * @interface BranchesClient
 */
export interface BranchesClient {
  /**
   * Lists branches in a project with optional search.
   * @param {string | number} projectId - Project ID or path
   * @param {Object} [options] - Optional filter parameters
   * @param {string} [options.search] - Search term for branch names
   * @param {number} [options.limit=20] - Maximum number of results
   * @returns {Promise<GitLabBranch[]>} Array of branches
   */
  list(
    projectId: string | number,
    options?: { search?: string; limit?: number }
  ): Promise<GitLabBranch[]>;

  /**
   * Gets detailed information about a specific branch.
   * @param {string | number} projectId - Project ID or path
   * @param {string} branch - Branch name
   * @returns {Promise<GitLabBranch>} Branch details with latest commit
   */
  get(projectId: string | number, branch: string): Promise<GitLabBranch>;

  /**
   * Creates a new branch from a ref (branch or commit).
   * @param {string | number} projectId - Project ID or path
   * @param {string} branch - New branch name
   * @param {string} ref - Source branch name or commit SHA
   * @returns {Promise<GitLabBranch>} Created branch
   */
  create(projectId: string | number, branch: string, ref: string): Promise<GitLabBranch>;

  /**
   * Deletes a branch from the repository.
   * @param {string | number} projectId - Project ID or path
   * @param {string} branch - Branch name to delete
   * @returns {Promise<void>}
   */
  delete(projectId: string | number, branch: string): Promise<void>;

  /**
   * Compares two branches showing commits and diffs.
   * @param {string | number} projectId - Project ID or path
   * @param {string} from - Source branch or commit
   * @param {string} to - Target branch or commit
   * @returns {Promise<BranchComparison>} Comparison result with commits and diffs
   */
  compare(projectId: string | number, from: string, to: string): Promise<BranchComparison>;
}

/**
 * Creates a branches client instance with the given GitLab SDK instance.
 * @param {InstanceType<typeof Gitlab>} gitlab - GitBeaker SDK instance
 * @returns {BranchesClient} Configured branches client
 */
export function createBranchesClient(gitlab: InstanceType<typeof Gitlab>): BranchesClient {
  return {
    async list(projectId, options = {}) {
      const branches = await gitlab.Branches.all(projectId, {
        search: options.search,
        perPage: options.limit || 20,
      });

      // Take only first page
      const limited = branches.slice(0, options.limit || 20);

      return limited.map(mapBranch);
    },

    async get(projectId, branch) {
      const b = await gitlab.Branches.show(projectId, branch);
      return mapBranch(b);
    },

    async create(projectId, branch, ref) {
      const b = await gitlab.Branches.create(projectId, branch, ref);
      return mapBranch(b);
    },

    async delete(projectId, branch) {
      await gitlab.Branches.remove(projectId, branch);
    },

    async compare(projectId, from, to) {
      const result = await gitlab.Repositories.compare(projectId, from, to);
      const resultRecord = result as unknown as Record<string, unknown>;
      return {
        commits: Array.isArray(result.commits) ? (result.commits as unknown[]).map(mapCommit) : [],
        diffs: Array.isArray(result.diffs)
          ? (result.diffs as unknown[]).map((d) => {
              const dRecord = d as Record<string, unknown>;
              return {
                old_path: String(dRecord.oldPath || dRecord['old_path'] || ''),
                new_path: String(dRecord.newPath || dRecord['new_path'] || ''),
                diff: String(dRecord.diff || ''),
              };
            })
          : [],
        compare_timeout: Boolean(resultRecord.compareTimeout || resultRecord['compare_timeout']),
        compare_same_ref: Boolean(resultRecord.compareSameRef || resultRecord['compare_same_ref']),
      };
    },
  };
}

/**
 * Maps GitBeaker branch response to standardized GitLabBranch type.
 * Handles both camelCase and snake_case field names from API.
 * @param {unknown} b - Raw branch object from GitLab API
 * @returns {GitLabBranch} Normalized branch object
 */
function mapBranch(b: unknown): GitLabBranch {
  const branch = b as Record<string, unknown>;
  return {
    name: String(branch.name),
    commit: mapCommit(branch.commit),
    protected: Boolean(branch.protected),
    merged: Boolean(branch.merged),
    default: Boolean(branch.default),
    web_url: String(branch.webUrl || branch['web_url'] || ''),
  };
}

/**
 * Maps GitBeaker commit response to standardized GitLabCommit type.
 * Handles both camelCase and snake_case field names from API.
 * @param {unknown} c - Raw commit object from GitLab API
 * @returns {GitLabCommit} Normalized commit object
 */
function mapCommit(c: unknown): GitLabCommit {
  const commit = c as Record<string, unknown>;
  const id = String(commit.id || '');
  const message = String(commit.message || '');
  return {
    id,
    short_id: String(commit.shortId || commit['short_id'] || id.substring(0, 8)),
    title: String(commit.title || message.split('\n')[0] || ''),
    message,
    author_name: String(commit.authorName || commit['author_name'] || ''),
    author_email: String(commit.authorEmail || commit['author_email'] || ''),
    created_at: String(commit.createdAt || commit['created_at'] || commit.committedDate || ''),
  };
}
