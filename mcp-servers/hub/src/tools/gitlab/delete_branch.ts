/**
 * GitLab: Delete Branch
 *
 * Deletes a branch from the repository.
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'deleteBranch',
  category: 'delete',
  service: 'gitlab',
  description: 'Delete a branch from the repository',
  keywords: ['gitlab', 'branch', 'delete', 'remove', 'git'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: ['string', 'number'],
        description: 'Project ID or path',
      },
      branch: {
        type: 'string',
        description: 'Branch name to delete',
      },
    },
    required: ['project_id', 'branch'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `await gitlab.deleteBranch({ project_id: "speedwave/core", branch: "feature/old" })`,
  inputExamples: [
    {
      description: 'Delete branch',
      input: { project_id: 'my-group/my-project', branch: 'feature/obsolete' },
    },
  ],
  deferLoading: true,
};

/**
 * Execute the deleteBranch tool.
 * @param params - Tool parameters
 * @param params.project_id - Project ID or path
 * @param params.branch - Branch name to delete
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.deleteBranch - Deletes a branch
 * @returns Promise resolving to success status or error
 */
export async function execute(
  params: { project_id: number | string; branch: string },
  context: { gitlab: { deleteBranch: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; error?: string }> {
  const { project_id, branch } = params;

  if (!project_id || !branch) {
    return {
      success: false,
      error: 'Missing required fields: project_id, branch',
    };
  }

  try {
    await context.gitlab.deleteBranch(params);
    return { success: true };
  } catch (error) {
    return handleExecutionError('deleteBranch', params as Record<string, unknown>, error);
  }
}
