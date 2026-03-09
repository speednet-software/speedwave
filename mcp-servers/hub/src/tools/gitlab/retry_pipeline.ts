/**
 * GitLab: Retry Pipeline
 *
 * Retry a failed or canceled pipeline.
 * @param {number|string} project_id - Project ID or path
 * @param {number} pipeline_id - Pipeline ID
 * @returns {object} Retried pipeline info
 * @example
 * // Retry failed pipeline
 * await gitlab.retryPipeline({
 *   project_id: "speedwave/core",
 *   pipeline_id: 123456
 * });
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'retryPipeline',
  category: 'write',
  description: 'Retry a failed or canceled pipeline',
  keywords: ['gitlab', 'pipeline', 'retry', 'rerun', 'ci', 'build'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: ['number', 'string'],
        description: "Project ID (numeric) or path (e.g., 'group/project')",
      },
      pipeline_id: { type: 'number', description: 'Pipeline ID' },
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
          web_url: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `await gitlab.retryPipeline({ project_id: "speedwave/core", pipeline_id: 123456 })`,
  inputExamples: [
    {
      description: 'Minimal: retry failed pipeline',
      input: { project_id: 'my-group/my-project', pipeline_id: 98765 },
    },
    {
      description: 'Partial: retry by path',
      input: { project_id: 'web-app', pipeline_id: 11111 },
    },
    {
      description: 'Full: retry by numeric ID',
      input: { project_id: 789, pipeline_id: 54321 },
    },
  ],
  service: 'gitlab',
  deferLoading: true,
};

/**
 * Retried pipeline information after retry operation.
 * @interface RetriedPipeline
 */
interface RetriedPipeline {
  id: number;
  iid: number;
  status: string;
  web_url: string;
}

/**
 * Executes the retry_pipeline tool to retry a failed or canceled CI/CD pipeline.
 * @param params - Tool parameters containing project_id and pipeline_id
 * @param params.project_id - Project ID or path
 * @param params.pipeline_id - Pipeline ID
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.retryPipeline - Function to retry pipelines
 * @returns Promise resolving to retried pipeline information or error
 */
export async function execute(
  params: { project_id: number | string; pipeline_id: number },
  context: { gitlab: { retryPipeline: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; pipeline?: RetriedPipeline; error?: string }> {
  const { project_id, pipeline_id } = params;

  if (!project_id || !pipeline_id) {
    return {
      success: false,
      error: 'Missing required fields: project_id, pipeline_id',
    };
  }

  try {
    const result = await context.gitlab.retryPipeline(params);

    return {
      success: true,
      pipeline: result as RetriedPipeline,
    };
  } catch (error) {
    return handleExecutionError('retryPipeline', params as Record<string, unknown>, error);
  }
}
