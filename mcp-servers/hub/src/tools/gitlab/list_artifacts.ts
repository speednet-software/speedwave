/**
 * GitLab: List Artifacts
 *
 * Lists all artifacts from a pipeline.
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'listArtifacts',
  category: 'read',
  description: 'List all artifacts from a pipeline',
  keywords: ['gitlab', 'artifacts', 'pipeline', 'ci', 'build'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: ['string', 'number'],
        description: 'Project ID or path',
      },
      pipeline_id: {
        type: 'number',
        description: 'Pipeline ID',
      },
    },
    required: ['project_id', 'pipeline_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      artifacts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file_type: { type: 'string' },
            size: { type: 'number' },
            filename: { type: 'string' },
            file_format: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const artifacts = await gitlab.listArtifacts({ project_id: "speedwave/core", pipeline_id: 12345 })`,
  inputExamples: [
    {
      description: 'List pipeline artifacts',
      input: { project_id: 'my-group/my-project', pipeline_id: 98765 },
    },
  ],
  service: 'gitlab',
  deferLoading: true,
};

/**
 * Execute the listArtifacts tool.
 * @param params - Tool parameters
 * @param params.project_id - Project ID or path
 * @param params.pipeline_id - Pipeline ID
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.listArtifacts - Lists job artifacts
 * @returns Promise resolving to artifacts list or error
 */
export async function execute(
  params: { project_id: number | string; pipeline_id: number },
  context: { gitlab: { listArtifacts: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; artifacts?: unknown[]; error?: string }> {
  const { project_id, pipeline_id } = params;

  if (!project_id || !pipeline_id) {
    return {
      success: false,
      error: 'Missing required fields: project_id, pipeline_id',
    };
  }

  try {
    const result = await context.gitlab.listArtifacts(params);
    return {
      success: true,
      artifacts: Array.isArray(result) ? result : [],
    };
  } catch (error) {
    return handleExecutionError('listArtifacts', params as Record<string, unknown>, error);
  }
}
