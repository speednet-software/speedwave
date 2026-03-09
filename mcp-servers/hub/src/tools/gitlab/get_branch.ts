/**
 * GitLab: Get Branch
 *
 * Gets detailed information about a specific branch.
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'getBranch',
  category: 'read',
  service: 'gitlab',
  description: 'Get details about a specific branch',
  keywords: ['gitlab', 'branch', 'get', 'show', 'git'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: ['string', 'number'],
        description: 'Project ID or path',
      },
      branch: {
        type: 'string',
        description: 'Branch name',
      },
    },
    required: ['project_id', 'branch'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      branch: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          commit: { type: 'object' },
          merged: { type: 'boolean' },
          protected: { type: 'boolean' },
          default: { type: 'boolean' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const branch = await gitlab.getBranch({ project_id: "speedwave/core", branch: "main" })`,
  inputExamples: [
    {
      description: 'Get branch details',
      input: { project_id: 'my-group/my-project', branch: 'develop' },
    },
  ],
  deferLoading: true,
};

/**
 * Execute the getBranch tool.
 * @param params - Tool parameters
 * @param params.project_id - Project ID or path
 * @param params.branch - Branch name
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.getBranch - Gets branch details
 * @returns Promise resolving to branch details or error
 */
export async function execute(
  params: { project_id: number | string; branch: string },
  context: { gitlab: { getBranch: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; branch?: unknown; error?: string }> {
  const { project_id, branch } = params;

  if (!project_id || !branch) {
    return {
      success: false,
      error: 'Missing required fields: project_id, branch',
    };
  }

  try {
    const result = await context.gitlab.getBranch(params);
    return {
      success: true,
      branch: result,
    };
  } catch (error) {
    return handleExecutionError('getBranch', params as Record<string, unknown>, error);
  }
}
