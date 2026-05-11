/**
 * GitHub Labels Domain - Handles repository label operations including listing and creation.
 * @module domains/labels
 */

import type { Octokit } from '@octokit/rest';
import type { GitHubLabel } from '../types.js';

/**
 * Client interface for GitHub label operations.
 * Provides methods to list and create repository labels.
 * @interface LabelsClient
 */
export interface LabelsClient {
  /**
   * Lists all labels defined in a repository.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {object} [options] - Optional pagination parameters
   * @param {number} [options.limit] - Maximum number of labels to return (default 100)
   * @returns {Promise<GitHubLabel[]>} Array of labels
   */
  list(owner: string, repo: string, options?: { limit?: number }): Promise<GitHubLabel[]>;

  /**
   * Creates a new label in a repository.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {object} params - Label creation parameters
   * @param {string} params.name - Label name
   * @param {string} params.color - Label color in hex format (a leading "#" is stripped)
   * @param {string} [params.description] - Optional label description
   * @returns {Promise<GitHubLabel>} Created label
   */
  create(
    owner: string,
    repo: string,
    params: { name: string; color: string; description?: string }
  ): Promise<GitHubLabel>;
}

/**
 * Creates a labels client instance.
 * @param {Octokit} octokit - Octokit REST instance
 * @returns {LabelsClient} Configured labels client
 */
export function createLabelsClient(octokit: Octokit): LabelsClient {
  return {
    async list(owner, repo, options = {}) {
      const limit = options.limit ?? 100;
      const items = (await octokit.paginate(octokit.rest.issues.listLabelsForRepo, {
        owner,
        repo,
        per_page: Math.min(limit, 100),
      })) as Array<Record<string, unknown>>;
      return items.slice(0, limit).map(mapLabel);
    },

    async create(owner, repo, params) {
      const { data } = await octokit.rest.issues.createLabel({
        owner,
        repo,
        name: params.name,
        color: params.color.replace(/^#/, ''),
        description: params.description,
      });
      return mapLabel(data as Record<string, unknown>);
    },
  };
}

/**
 * Normalizes a raw GitHub label object to the {@link GitHubLabel} shape.
 * @param {unknown} l - Raw label object from the GitHub API
 * @returns {GitHubLabel} Normalized label
 */
function mapLabel(l: unknown): GitHubLabel {
  const o = l as Record<string, unknown>;
  return {
    id: Number(o.id),
    name: String(o.name || ''),
    color: String(o.color || ''),
    description: o.description ? String(o.description) : undefined,
  };
}
