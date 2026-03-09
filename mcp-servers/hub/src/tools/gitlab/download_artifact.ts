/**
 * GitLab: Download Artifact
 *
 * Downloads artifact from a job (returns base64 encoded content).
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'downloadArtifact',
  category: 'read',
  description: 'Download artifact from a CI job',
  keywords: ['gitlab', 'artifact', 'download', 'ci', 'build'],
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
      artifact: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          size: { type: 'number' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const artifact = await gitlab.downloadArtifact({ project_id: "speedwave/core", job_id: 54321 })`,
  inputExamples: [
    {
      description: 'Download job artifact',
      input: { project_id: 'my-group/my-project', job_id: 11111 },
    },
  ],
  service: 'gitlab',
  deferLoading: true,
};

/**
 * Execute the downloadArtifact tool.
 * @param params - Tool parameters
 * @param params.project_id - Project ID or path
 * @param params.job_id - Job ID
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.downloadArtifact - Downloads job artifacts
 * @returns Promise resolving to artifact content or error
 */
export async function execute(
  params: { project_id: number | string; job_id: number },
  context: { gitlab: { downloadArtifact: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; artifact?: unknown; error?: string }> {
  const { project_id, job_id } = params;

  if (!project_id || !job_id) {
    return {
      success: false,
      error: 'Missing required fields: project_id, job_id',
    };
  }

  try {
    const result = await context.gitlab.downloadArtifact(params);
    return {
      success: true,
      artifact: result,
    };
  } catch (error) {
    return handleExecutionError('downloadArtifact', params as Record<string, unknown>, error);
  }
}
