/**
 * GitLab: Create Branch
 *
 * Creates a new branch from a ref (branch or commit).
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'createBranch',
  category: 'write',
  service: 'gitlab',
  description: 'Create a new branch in the repository',
  keywords: ['gitlab', 'branch', 'create', 'new', 'git'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: ['string', 'number'],
        description: 'Project ID or path',
      },
      branch: {
        type: 'string',
        description: 'New branch name',
      },
      ref: {
        type: 'string',
        description: 'Source branch or commit SHA',
      },
    },
    required: ['project_id', 'branch', 'ref'],
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
          web_url: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const branch = await gitlab.createBranch({ project_id: "speedwave/core", branch: "feature/new", ref: "main" })`,
  inputExamples: [
    {
      description: 'Create branch from main',
      input: { project_id: 'my-group/my-project', branch: 'feature/auth', ref: 'main' },
    },
  ],
  deferLoading: true,
};

/**
 * Execute the createBranch tool.
 * @param params - Tool parameters
 * @param params.project_id - Project ID or path
 * @param params.branch - New branch name
 * @param params.ref - Source branch or commit SHA
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.createBranch - Creates a new branch
 * @returns Promise resolving to created branch or error
 */
export async function execute(
  params: { project_id: number | string; branch: string; ref: string },
  context: { gitlab: { createBranch: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; branch?: unknown; error?: string }> {
  const { project_id, branch, ref } = params;

  if (!project_id || !branch || !ref) {
    return {
      success: false,
      error: 'Missing required fields: project_id, branch, ref',
    };
  }

  try {
    const result = await context.gitlab.createBranch(params);
    return {
      success: true,
      branch: result,
    };
  } catch (error) {
    return handleExecutionError('createBranch', params as Record<string, unknown>, error);
  }
}
