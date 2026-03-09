/**
 * GitLab: Show Project
 *
 * Get detailed information about a specific GitLab project.
 * @param {number|string} project_id - Project ID (numeric) or path (e.g., 'group/project')
 * @returns {object} Project details
 * @example
 * // Get project by ID
 * const project = await gitlab.showProject({ project_id: 123 });
 *
 * // Get project by path
 * const project = await gitlab.showProject({
 *   project_id: "speedwave/core"
 * });
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'getProjectFull',
  category: 'read',
  description: 'Get full details about a specific GitLab project',
  keywords: ['gitlab', 'project', 'show', 'get', 'detail', 'full'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: ['number', 'string'],
        description: "Project ID or path (e.g., 'group/project')",
      },
      include: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional data to include',
      },
    },
    required: ['project_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      project: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          name: { type: 'string' },
          description: { type: 'string' },
          path_with_namespace: { type: 'string' },
          web_url: { type: 'string' },
          default_branch: { type: 'string' },
          visibility: { type: 'string' },
          created_at: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const project = await gitlab.getProjectFull({ project_id: "speedwave/core" })`,
  inputExamples: [
    {
      description: 'By path',
      input: { project_id: 'my-group/my-project' },
    },
    {
      description: 'By numeric ID',
      input: { project_id: 123 },
    },
  ],
  service: 'gitlab',
  deferLoading: true,
};

/**
 * Detailed project information including metadata and activity.
 * @interface ProjectDetail
 */
interface ProjectDetail {
  id: number;
  name: string;
  path_with_namespace: string;
  description?: string;
  web_url: string;
  default_branch: string;
  created_at: string;
  last_activity_at: string;
}

/**
 * Executes the show_project tool to retrieve detailed information about a specific GitLab project.
 * @param params - Tool parameters containing project_id
 * @param params.project_id - Project ID or path
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.showProject - Function to show project details
 * @returns Promise resolving to project details or error
 */
export async function execute(
  params: { project_id: number | string },
  context: { gitlab: { showProject: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; project?: ProjectDetail; error?: string }> {
  const { project_id } = params;

  if (!project_id) {
    return {
      success: false,
      error: 'Missing required field: project_id',
    };
  }

  try {
    const result = await context.gitlab.showProject(params);

    return {
      success: true,
      project: result as ProjectDetail,
    };
  } catch (error) {
    return handleExecutionError('getProjectFull', params as Record<string, unknown>, error);
  }
}
