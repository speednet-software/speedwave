/**
 * GitLab: List MR Discussions
 *
 * Lists all discussion threads on a merge request.
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'listMrDiscussions',
  category: 'read',
  service: 'gitlab',
  description: 'List all discussions (threaded comments) on a merge request',
  keywords: ['gitlab', 'merge', 'request', 'discussions', 'threads'],
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
      discussions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            notes: { type: 'array' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const discussions = await gitlab.listMrDiscussions({ project_id: "speedwave/core", mr_iid: 42 })`,
  inputExamples: [
    {
      description: 'List MR discussions',
      input: { project_id: 'my-group/my-project', mr_iid: 123 },
    },
  ],
  deferLoading: true,
};

/**
 * Execute the listMrDiscussions tool.
 * @param params - Tool parameters
 * @param params.project_id - Project ID or path
 * @param params.mr_iid - Merge request IID
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.listMrDiscussions - Lists merge request discussions
 * @returns Promise resolving to discussions list or error
 */
export async function execute(
  params: { project_id: number | string; mr_iid: number },
  context: { gitlab: { listMrDiscussions: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; discussions?: unknown[]; error?: string }> {
  const { project_id, mr_iid } = params;

  if (!project_id || !mr_iid) {
    return {
      success: false,
      error: 'Missing required fields: project_id, mr_iid',
    };
  }

  try {
    const result = await context.gitlab.listMrDiscussions(params);
    return {
      success: true,
      discussions: Array.isArray(result) ? result : [],
    };
  } catch (error) {
    return handleExecutionError('listMrDiscussions', params as Record<string, unknown>, error);
  }
}
