/**
 * GitLab: List Branches
 *
 * Lists branches in a project with optional search.
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'listBranches',
  category: 'read',
  service: 'gitlab',
  description: 'List all branches in a GitLab project',
  keywords: ['gitlab', 'branches', 'list', 'git', 'refs'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: ['string', 'number'],
        description: 'Project ID or path',
      },
      search: {
        type: 'string',
        description: 'Filter branches by name',
      },
      limit: {
        type: 'number',
        description: 'Max results (default 20)',
      },
    },
    required: ['project_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      branches: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            merged: { type: 'boolean' },
            protected: { type: 'boolean' },
            default: { type: 'boolean' },
            web_url: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const branches = await gitlab.listBranches({ project_id: "speedwave/core" })`,
  inputExamples: [
    {
      description: 'List all branches',
      input: { project_id: 'my-group/my-project' },
    },
    {
      description: 'Search branches',
      input: { project_id: 'my-group/my-project', search: 'feature' },
    },
  ],
  deferLoading: true,
};

/**
 * Execute the listBranches tool.
 * @param params - Tool parameters
 * @param params.project_id - Project ID or path
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.listBranches - Lists repository branches
 * @returns Promise resolving to branches list or error
 */
export async function execute(
  params: { project_id: number | string; [key: string]: unknown },
  context: { gitlab: { listBranches: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; branches?: unknown[]; error?: string }> {
  const { project_id } = params;

  if (!project_id) {
    return {
      success: false,
      error: 'Missing required field: project_id',
    };
  }

  try {
    const result = await context.gitlab.listBranches(params);
    return {
      success: true,
      branches: Array.isArray(result) ? result : [],
    };
  } catch (error) {
    return handleExecutionError('listBranches', params as Record<string, unknown>, error);
  }
}
