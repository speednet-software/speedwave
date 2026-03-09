/**
 * GitLab: List MR Commits
 *
 * Lists all commits in a merge request.
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'listMrCommits',
  category: 'read',
  service: 'gitlab',
  description: 'List all commits in a merge request',
  keywords: ['gitlab', 'merge', 'request', 'commits', 'history'],
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
      commits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            author_name: { type: 'string' },
            created_at: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const commits = await gitlab.listMrCommits({ project_id: "speedwave/core", mr_iid: 42 })`,
  inputExamples: [
    {
      description: 'List MR commits',
      input: { project_id: 'my-group/my-project', mr_iid: 123 },
    },
  ],
  deferLoading: true,
};

/**
 * Execute the listMrCommits tool.
 * @param params - Tool parameters
 * @param params.project_id - Project ID or path
 * @param params.mr_iid - Merge request IID
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.listMrCommits - Lists merge request commits
 * @returns Promise resolving to commits list or error
 */
export async function execute(
  params: { project_id: number | string; mr_iid: number },
  context: { gitlab: { listMrCommits: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; commits?: unknown[]; error?: string }> {
  const { project_id, mr_iid } = params;

  if (!project_id || !mr_iid) {
    return {
      success: false,
      error: 'Missing required fields: project_id, mr_iid',
    };
  }

  try {
    const result = await context.gitlab.listMrCommits(params);
    return {
      success: true,
      commits: Array.isArray(result) ? result : [],
    };
  } catch (error) {
    return handleExecutionError('listMrCommits', params as Record<string, unknown>, error);
  }
}
