/**
 * GitLab: List Projects
 *
 * List accessible GitLab projects (repositories).
 * Supports search and filtering.
 * @param {string} [search] - Search query to filter projects by name or path
 * @param {boolean} [owned] - Only show owned projects (default: false shows all accessible)
 * @param {number} [limit=20] - Maximum number of projects to return (max: 100)
 * @returns {object} Array of projects
 * @example
 * // List all accessible projects
 * const projects = await gitlab.listProjects();
 *
 * // Search for specific project
 * const found = await gitlab.listProjects({
 *   search: "speedwave"
 * });
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'listProjectIds',
  category: 'read',
  description: 'List accessible GitLab project IDs and basic info',
  keywords: ['gitlab', 'projects', 'list', 'repositories', 'repos', 'ids'],
  inputSchema: {
    type: 'object',
    properties: {
      search: { type: 'string', description: 'Search query to filter projects' },
      owned: { type: 'boolean', description: 'Only show owned projects' },
      limit: { type: 'number', description: 'Maximum projects (default: 20, max: 100)' },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      projects: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            name: { type: 'string' },
            path_with_namespace: { type: 'string' },
            web_url: { type: 'string' },
            default_branch: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const { projects, count } = await gitlab.listProjectIds({ search: "speedwave" })`,
  inputExamples: [
    {
      description: 'Minimal: list all projects',
      input: {},
    },
    {
      description: 'Partial: search projects',
      input: { search: 'backend' },
    },
    {
      description: 'Full: owned projects only',
      input: { search: 'api', owned: true, limit: 50 },
    },
  ],
  service: 'gitlab',
  deferLoading: true,
};

/**
 * Project summary information for listing accessible repositories.
 * @interface Project
 */
interface Project {
  id: number;
  name: string;
  path_with_namespace: string;
  description?: string;
  web_url: string;
}

/**
 * Executes the list_projects tool to retrieve accessible GitLab projects with optional filters.
 * @param params - Tool parameters containing optional search, owned, and limit filters
 * @param params.search - Search query string
 * @param params.owned - Filter by owned projects
 * @param params.limit - Maximum number of results to return
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.listProjects - Function to list projects
 * @returns Promise resolving to array of projects or error
 */
export async function execute(
  params: { search?: string; owned?: boolean; limit?: number },
  context: { gitlab: { listProjects: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; projects?: Project[]; error?: string }> {
  try {
    const result = await context.gitlab.listProjects(params);
    const data = result as { projects?: Project[] };

    return {
      success: true,
      projects: data.projects || (Array.isArray(result) ? result : []),
    };
  } catch (error) {
    return handleExecutionError('listProjectIds', params as Record<string, unknown>, error);
  }
}
