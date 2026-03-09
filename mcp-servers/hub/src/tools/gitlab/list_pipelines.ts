/**
 * GitLab: List Pipelines
 *
 * List CI/CD pipelines for a project.
 * @param {number|string} project_id - Project ID or path
 * @param {string} [ref] - Filter by branch/tag name
 * @param {string} [status] - Filter by pipeline status
 * @param {number} [limit=5] - Maximum pipelines to return (max: 100)
 * @param {number} [page=1] - Page number for pagination
 * @returns {object} Array of pipelines
 * @example
 * // List recent pipelines
 * const pipelines = await gitlab.listPipelines({
 *   project_id: "speedwave/core"
 * });
 *
 * // List failed pipelines
 * const failed = await gitlab.listPipelines({
 *   project_id: "speedwave/core",
 *   status: "failed"
 * });
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'listPipelineIds',
  category: 'read',
  description: 'List CI/CD pipeline IDs for a project',
  keywords: ['gitlab', 'pipeline', 'ci', 'cd', 'list', 'build', 'ids'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['number', 'string'], description: 'Project ID or path' },
      status: {
        type: 'string',
        enum: ['running', 'pending', 'success', 'failed', 'canceled'],
        description: 'Filter by status',
      },
      ref: { type: 'string', description: 'Filter by branch/tag name' },
      limit: { type: 'number', description: 'Maximum pipelines (default: 5, max: 100)' },
    },
    required: ['project_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      pipelines: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            status: {
              type: 'string',
              enum: ['running', 'pending', 'success', 'failed', 'canceled'],
            },
            ref: { type: 'string', description: 'Branch or tag name' },
            sha: { type: 'string', description: 'Commit SHA' },
            web_url: { type: 'string' },
            created_at: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const { pipelines, count } = await gitlab.listPipelineIds({ project_id: "speedwave/core", status: "failed" })`,
  inputExamples: [
    {
      description: 'Minimal: recent pipelines',
      input: { project_id: 'my-group/my-project' },
    },
    {
      description: 'Partial: failed pipelines',
      input: { project_id: 'my-group/my-project', status: 'failed' },
    },
    {
      description: 'Full: branch pipelines',
      input: { project_id: 'my-group/my-project', status: 'success', ref: 'main', limit: 20 },
    },
  ],
  service: 'gitlab',
  deferLoading: true,
};

/**
 * Pipeline information summary for CI/CD workflows.
 * @interface Pipeline
 */
interface Pipeline {
  id: number;
  iid: number;
  status: string;
  ref: string;
  sha: string;
  web_url: string;
  created_at: string;
}

/**
 * Executes the list_pipelines tool to retrieve CI/CD pipeline list with optional filters.
 * @param params - Tool parameters containing project_id and optional filters (ref, status, limit, page)
 * @param params.project_id - Project ID or path
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.listPipelines - Function to list pipelines
 * @returns Promise resolving to array of pipelines or error
 */
export async function execute(
  params: { project_id: number | string; [key: string]: unknown },
  context: { gitlab: { listPipelines: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; pipelines?: Pipeline[]; error?: string }> {
  const { project_id } = params;

  if (!project_id) {
    return {
      success: false,
      error: 'Missing required field: project_id',
    };
  }

  try {
    const result = await context.gitlab.listPipelines(params);

    return {
      success: true,
      pipelines: Array.isArray(result) ? result : [],
    };
  } catch (error) {
    return handleExecutionError('listPipelineIds', params as Record<string, unknown>, error);
  }
}
