/**
 * GitLab: Show Pipeline
 *
 * Get detailed pipeline information including job statuses.
 * @param {number|string} project_id - Project ID or path
 * @param {number} pipeline_id - Pipeline ID
 * @returns {object} Pipeline details with jobs
 * @example
 * // Get pipeline details
 * const pipeline = await gitlab.showPipeline({
 *   project_id: "speedwave/core",
 *   pipeline_id: 123456
 * });
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'getPipelineFull',
  category: 'read',
  description: 'Get full pipeline details including job statuses',
  keywords: ['gitlab', 'pipeline', 'ci', 'details', 'jobs', 'status', 'full'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: ['number', 'string'],
        description: "Project ID (numeric) or path (e.g., 'group/project')",
      },
      pipeline_id: { type: 'number', description: 'Pipeline ID' },
      include: {
        type: 'array',
        items: { type: 'string' },
        description: "Additional data to include (e.g., ['jobs'])",
      },
    },
    required: ['project_id', 'pipeline_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      pipeline: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          status: { type: 'string' },
          ref: { type: 'string' },
          sha: { type: 'string' },
          web_url: { type: 'string' },
          created_at: { type: 'string' },
          updated_at: { type: 'string' },
          duration: { type: 'number', description: 'Duration in seconds' },
        },
      },
      jobs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            name: { type: 'string' },
            stage: { type: 'string' },
            status: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const pipeline = await gitlab.getPipelineFull({ project_id: "speedwave/core", pipeline_id: 123456 })`,
  inputExamples: [
    {
      description: 'Minimal: get pipeline details',
      input: { project_id: 'my-group/my-project', pipeline_id: 98765 },
    },
    {
      description: 'Partial: pipeline by path',
      input: { project_id: 'web-app', pipeline_id: 11111 },
    },
    {
      description: 'Full: pipeline by numeric ID',
      input: { project_id: 789, pipeline_id: 54321 },
    },
  ],
  service: 'gitlab',
  deferLoading: true,
};

/**
 * Detailed pipeline information including jobs and execution metadata.
 * @interface PipelineDetail
 */
interface PipelineDetail {
  id: number;
  iid: number;
  status: string;
  ref: string;
  sha: string;
  web_url: string;
  created_at: string;
  updated_at: string;
  duration: number;
  jobs?: Array<{
    id: number;
    name: string;
    stage: string;
    status: string;
  }>;
}

/**
 * Executes the show_pipeline tool to retrieve detailed pipeline information including job statuses.
 * @param params - Tool parameters containing project_id and pipeline_id
 * @param params.project_id - Project ID or path
 * @param params.pipeline_id - Pipeline ID
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.showPipeline - Function to show pipeline details
 * @returns Promise resolving to pipeline details or error
 */
export async function execute(
  params: { project_id: number | string; pipeline_id: number },
  context: { gitlab: { showPipeline: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; pipeline?: PipelineDetail; error?: string }> {
  const { project_id, pipeline_id } = params;

  if (!project_id || !pipeline_id) {
    return {
      success: false,
      error: 'Missing required fields: project_id, pipeline_id',
    };
  }

  try {
    const result = await context.gitlab.showPipeline(params);

    return {
      success: true,
      pipeline: result as PipelineDetail,
    };
  } catch (error) {
    return handleExecutionError('getPipelineFull', params as Record<string, unknown>, error);
  }
}
