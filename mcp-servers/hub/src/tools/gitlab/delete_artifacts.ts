/**
 * GitLab: Delete Artifacts
 *
 * Deletes artifacts from a job.
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'deleteArtifacts',
  category: 'delete',
  description: 'Delete artifacts from a CI job',
  keywords: ['gitlab', 'artifacts', 'delete', 'remove', 'ci'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: ['string', 'number'],
        description: 'Project ID or path',
      },
      job_id: {
        type: 'number',
        description: 'Job ID',
      },
    },
    required: ['project_id', 'job_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `await gitlab.deleteArtifacts({ project_id: "speedwave/core", job_id: 54321 })`,
  inputExamples: [
    {
      description: 'Delete job artifacts',
      input: { project_id: 'my-group/my-project', job_id: 11111 },
    },
  ],
  service: 'gitlab',
  deferLoading: true,
};

/**
 * Execute the deleteArtifacts tool.
 * @param params - Tool parameters
 * @param params.project_id - Project ID or path
 * @param params.job_id - Job ID
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.deleteArtifacts - Deletes job artifacts
 * @returns Promise resolving to success status or error
 */
export async function execute(
  params: { project_id: number | string; job_id: number },
  context: { gitlab: { deleteArtifacts: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; error?: string }> {
  const { project_id, job_id } = params;

  if (!project_id || !job_id) {
    return {
      success: false,
      error: 'Missing required fields: project_id, job_id',
    };
  }

  try {
    await context.gitlab.deleteArtifacts(params);
    return { success: true };
  } catch (error) {
    return handleExecutionError('deleteArtifacts', params as Record<string, unknown>, error);
  }
}
