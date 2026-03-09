/**
 * GitLab: List MR Pipelines
 *
 * Lists all pipelines associated with a merge request.
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'listMrPipelines',
  category: 'read',
  service: 'gitlab',
  description: 'List all pipelines for a merge request',
  keywords: ['gitlab', 'merge', 'request', 'pipelines', 'ci'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: ['string', 'number'],
        description: 'Project ID or path',
      },
      mr_iid: {
        type: 'number',
        description: 'Merge request IID',
      },
    },
    required: ['project_id', 'mr_iid'],
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
            status: { type: 'string' },
            ref: { type: 'string' },
            created_at: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const pipelines = await gitlab.listMrPipelines({ project_id: "speedwave/core", mr_iid: 42 })`,
  inputExamples: [
    {
      description: 'List MR pipelines',
      input: { project_id: 'my-group/my-project', mr_iid: 123 },
    },
  ],
  deferLoading: true,
};

/**
 * Execute the listMrPipelines tool.
 * @param params - Tool parameters
 * @param params.project_id - Project ID or path
 * @param params.mr_iid - Merge request IID
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.listMrPipelines - Lists merge request pipelines
 * @returns Promise resolving to pipelines list or error
 */
export async function execute(
  params: { project_id: number | string; mr_iid: number },
  context: { gitlab: { listMrPipelines: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; pipelines?: unknown[]; error?: string }> {
  const { project_id, mr_iid } = params;

  if (!project_id || !mr_iid) {
    return {
      success: false,
      error: 'Missing required fields: project_id, mr_iid',
    };
  }

  try {
    const result = await context.gitlab.listMrPipelines(params);
    return {
      success: true,
      pipelines: Array.isArray(result) ? result : [],
    };
  } catch (error) {
    return handleExecutionError('listMrPipelines', params as Record<string, unknown>, error);
  }
}
