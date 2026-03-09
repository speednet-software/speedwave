/**
 \* GitLab Repository Domain - Handles repository operations including
 * file tree retrieval, file content, and git blame
 * @module domains/repository
 */

import { Gitlab } from '@gitbeaker/rest';
import type { GitLabTreeItem, GitLabFileContent, GitLabBlame, GitLabCommit } from '../types.js';

/**
 * Client interface for GitLab repository operations.
 * Provides methods to browse repository content, read files, and view git blame.
 * @interface RepositoryClient
 */
export interface RepositoryClient {
  /**
   * Gets repository file tree structure.
   * @param {string | number} projectId - Project ID or path
   * @param {Object} [options] - Optional tree options
   * @param {string} [options.path] - Path within repository (defaults to root)
   * @param {string} [options.ref] - Branch, tag, or commit SHA (defaults to default branch)
   * @param {boolean} [options.recursive] - Get tree recursively (default: false)
   * @returns {Promise<GitLabTreeItem[]>} Array of tree items (files and directories)
   */
  getTree(
    projectId: string | number,
    options?: { path?: string; ref?: string; recursive?: boolean }
  ): Promise<GitLabTreeItem[]>;

  /**
   * Gets file content from repository with automatic base64 decoding.
   * @param {string | number} projectId - Project ID or path
   * @param {string} filePath - Path to file in repository
   * @param {string} [ref='main'] - Branch, tag, or commit SHA
   * @returns {Promise<GitLabFileContent>} File metadata and decoded content
   */
  getFile(projectId: string | number, filePath: string, ref?: string): Promise<GitLabFileContent>;

  /**
   * Gets git blame information for a file showing who last modified each line.
   * @param {string | number} projectId - Project ID or path
   * @param {string} filePath - Path to file in repository
   * @param {string} [ref='main'] - Branch, tag, or commit SHA
   * @returns {Promise<GitLabBlame[]>} Array of blame entries with commit info
   */
  getBlame(projectId: string | number, filePath: string, ref?: string): Promise<GitLabBlame[]>;
}

/**
 * Maps GitLab API commit response to standardized GitLabCommit type.
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
 * Creates a repository client instance with the given GitLab SDK instance.
 * @param {InstanceType<typeof Gitlab>} gitlab - GitBeaker SDK instance
 * @returns {RepositoryClient} Configured repository client
 */
export function createRepositoryClient(gitlab: InstanceType<typeof Gitlab>): RepositoryClient {
  return {
    async getTree(projectId, options = {}) {
      const tree = await gitlab.Repositories.allRepositoryTrees(projectId, {
        path: options.path,
        ref: options.ref,
        recursive: options.recursive,
      });

      return tree.map((item) => ({
        id: String(item.id),
        name: String(item.name),
        type: String(item.type) as 'tree' | 'blob',
        path: String(item.path),
        mode: String(item.mode),
      }));
    },

    async getFile(projectId, filePath, ref = 'main') {
      const file = await gitlab.RepositoryFiles.show(projectId, filePath, ref);

      // Decode base64 content if needed
      let content = String(file.content || '');
      const encoding = String(file.encoding || 'text');

      if (encoding === 'base64') {
        content = Buffer.from(content, 'base64').toString('utf-8');
      }

      return {
        file_name: String(file.fileName || file.file_name || ''),
        file_path: String(file.filePath || file.file_path || filePath),
        size: Number(file.size || 0),
        encoding,
        content,
        ref: String(file.ref || ref),
      };
    },

    async getBlame(projectId, filePath, ref = 'main') {
      const blame = await gitlab.RepositoryFiles.allFileBlames(projectId, filePath, ref);

      if (!Array.isArray(blame)) {
        return [];
      }

      return blame.map((b) => {
        const blameRecord = b as Record<string, unknown>;
        return {
          commit: mapCommit(blameRecord.commit),
          lines: Array.isArray(blameRecord.lines) ? (blameRecord.lines as string[]) : [],
        };
      });
    },
  };
}
