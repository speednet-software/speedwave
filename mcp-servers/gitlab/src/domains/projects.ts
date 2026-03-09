/**
 \* GitLab Projects Domain - Handles project listing, retrieval,
 * and code search operations
 * @module domains/projects
 */

import { Gitlab } from '@gitbeaker/rest';
import type { GitLabProject } from '../types.js';

/**
 * Client interface for GitLab project operations.
 * Provides methods to list, retrieve, and search projects.
 * @interface ProjectsClient
 */
export interface ProjectsClient {
  /**
   * Lists projects with optional filtering and search.
   * @param {Object} [options] - Optional filter parameters
   * @param {string} [options.search] - Search term for project name
   * @param {number} [options.limit=20] - Maximum number of results
   * @param {boolean} [options.owned] - Show only owned projects
   * @returns {Promise<GitLabProject[]>} Array of project objects
   */
  list(options?: { search?: string; limit?: number; owned?: boolean }): Promise<GitLabProject[]>;

  /**
   * Shows detailed information about a specific project.
   * @param {string | number} projectId - Project ID or path (e.g., "group/project")
   * @param {Object} [options] - Optional additional data to include
   * @param {boolean} [options.license] - Include license information
   * @param {boolean} [options.statistics] - Include repository statistics
   * @returns {Promise<GitLabProject & { license?: unknown; statistics?: unknown }>} Project details with optional extended data
   */
  show(
    projectId: string | number,
    options?: { license?: boolean; statistics?: boolean }
  ): Promise<GitLabProject & { license?: unknown; statistics?: unknown }>;

  /**
   * Searches for code across GitLab projects.
   * @param {string} query - Search query string
   * @param {Object} [options] - Optional search parameters
   * @param {string | number} [options.project_id] - Limit search to specific project
   * @returns {Promise<unknown[]>} Array of search results (blobs with matching code)
   */
  searchCode(query: string, options?: { project_id?: string | number }): Promise<unknown[]>;
}

/**
 * Creates a projects client instance with the given GitLab SDK instance.
 * @param {InstanceType<typeof Gitlab>} gitlab - GitBeaker SDK instance
 * @returns {ProjectsClient} Configured projects client
 */
export function createProjectsClient(gitlab: InstanceType<typeof Gitlab>): ProjectsClient {
  return {
    async list(options = {}) {
      const projects = await gitlab.Projects.all({
        search: options.search,
        perPage: options.limit || 20,
        owned: options.owned,
      });

      // Take only first page (limit results)
      const limited = projects.slice(0, options.limit || 20);

      return limited.map((p) => ({
        id: p.id as number,
        name: String(p.name),
        path_with_namespace: String(p.pathWithNamespace || p.path_with_namespace || ''),
        description: p.description ? String(p.description) : undefined,
        web_url: String(p.webUrl || p.web_url || ''),
        default_branch: p.defaultBranch ? String(p.defaultBranch) : undefined,
      }));
    },

    async show(projectId, options = {}) {
      const p = await gitlab.Projects.show(projectId, {
        license: options.license,
        statistics: options.statistics,
      });
      return {
        id: p.id as number,
        name: String(p.name),
        path_with_namespace: String(p.pathWithNamespace || ''),
        description: p.description ? String(p.description) : undefined,
        web_url: String(p.webUrl || ''),
        default_branch: p.defaultBranch ? String(p.defaultBranch) : undefined,
        ...(options.license && p.license ? { license: p.license } : {}),
        ...(options.statistics && p.statistics ? { statistics: p.statistics } : {}),
      };
    },

    async searchCode(query, options = {}) {
      // Search within project or globally
      if (options.project_id) {
        const results = await gitlab.Search.all('blobs' as const, query, {
          projectId: options.project_id,
        });
        return results as unknown[];
      }
      const results = await gitlab.Search.all('blobs' as const, query);
      return results as unknown[];
    },
  };
}
