/**
 * GitHub Repository Domain - Handles repository content browsing: trees, file
 * contents, and committing file changes.
 * @module domains/repository
 */

import type { Octokit } from '@octokit/rest';
import type { GitHubTreeItem, GitHubFileContent } from '../types.js';

/**
 * Client interface for GitHub repository content operations.
 * @interface RepositoryClient
 */
export interface RepositoryClient {
  /**
   * Gets the entries of a Git tree, optionally recursively.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {string} treeSha - Tree SHA, branch, or tag to read the tree from
   * @param {object} [options] - Tree options
   * @param {boolean} [options.recursive] - Include nested directories recursively (default false)
   * @returns {Promise<GitHubTreeItem[]>} Array of tree items (files and directories)
   */
  getTree(
    owner: string,
    repo: string,
    treeSha: string,
    options?: { recursive?: boolean }
  ): Promise<GitHubTreeItem[]>;

  /**
   * Gets the decoded UTF-8 content of a file in a repository.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {string} path - File path from the repository root
   * @param {object} [options] - Read options
   * @param {string} [options.ref] - Branch, tag, or commit SHA to read from
   * @returns {Promise<GitHubFileContent>} File content (decoded to UTF-8) and metadata
   * @throws {Error} if the path resolves to a directory rather than a file
   */
  getContent(
    owner: string,
    repo: string,
    path: string,
    options?: { ref?: string }
  ): Promise<GitHubFileContent>;

  /**
   * Creates or updates a file in a repository (commits the change).
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {object} params - File parameters
   * @param {string} params.path - File path from the repository root
   * @param {string} params.content - File content (UTF-8; base64-encoded before sending)
   * @param {string} params.message - Commit message
   * @param {string} [params.branch] - Branch to commit to (default: the repo's default branch)
   * @param {string} [params.sha] - Blob SHA of the file being replaced (required by GitHub for updates)
   * @returns {Promise<{ commit_sha: string; path: string; html_url: string }>} Resulting commit info
   */
  createOrUpdateFile(
    owner: string,
    repo: string,
    params: { path: string; content: string; message: string; branch?: string; sha?: string }
  ): Promise<{ commit_sha: string; path: string; html_url: string }>;
}

/**
 * Creates a repository client instance.
 * @param {Octokit} octokit - Octokit REST instance
 * @returns {RepositoryClient} Configured repository client
 */
export function createRepositoryClient(octokit: Octokit): RepositoryClient {
  return {
    async getTree(owner, repo, treeSha, options = {}) {
      const { data } = await octokit.rest.git.getTree({
        owner,
        repo,
        tree_sha: treeSha,
        recursive: options.recursive ? '1' : undefined,
      });
      const o = data as Record<string, unknown>;
      const tree = Array.isArray(o.tree) ? (o.tree as unknown[]) : [];
      return tree.map(mapTreeItem);
    },

    async getContent(owner, repo, path, options = {}) {
      const { data } = await octokit.rest.repos.getContent({
        owner,
        repo,
        path,
        ref: options.ref,
      });
      if (Array.isArray(data)) {
        throw new Error('Path is not a file');
      }
      const file = data as Record<string, unknown>;
      if (file.type !== 'file' || typeof file.content !== 'string') {
        throw new Error('Path is not a file');
      }
      return {
        path: String(file.path || path),
        content: Buffer.from(file.content, 'base64').toString('utf-8'),
        encoding: 'utf-8',
        sha: String(file.sha || ''),
        size: Number(file.size || 0),
      };
    },

    async createOrUpdateFile(owner, repo, params) {
      const { data } = await octokit.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: params.path,
        message: params.message,
        content: Buffer.from(params.content, 'utf-8').toString('base64'),
        branch: params.branch,
        sha: params.sha,
      });
      const o = data as Record<string, unknown>;
      const commit = (o.commit || {}) as Record<string, unknown>;
      const content = (o.content || {}) as Record<string, unknown>;
      return {
        commit_sha: String(commit.sha || ''),
        path: params.path,
        html_url: String(content.html_url || ''),
      };
    },
  };
}

/**
 * Normalizes a raw GitHub tree entry to the {@link GitHubTreeItem} shape.
 * @param {unknown} t - Raw tree entry from the GitHub API
 * @returns {GitHubTreeItem} Normalized tree item
 */
function mapTreeItem(t: unknown): GitHubTreeItem {
  const o = t as Record<string, unknown>;
  return {
    path: String(o.path || ''),
    mode: String(o.mode || ''),
    type: String(o.type || 'blob') as 'blob' | 'tree',
    sha: String(o.sha || ''),
    size: o.size !== undefined && o.size !== null ? Number(o.size) : undefined,
  };
}
