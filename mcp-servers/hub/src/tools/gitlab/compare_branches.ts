/**
 * GitLab: Compare Branches
 *
 * Compares two branches showing commits and diffs between them.
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'compareBranches',
  category: 'read',
  service: 'gitlab',
  description: 'Compare two branches to see differences',
  keywords: ['gitlab', 'compare', 'diff', 'branches', 'git'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: ['string', 'number'],
        description: 'Project ID or path',
      },
      from: {
        type: 'string',
        description: 'Base branch name',
      },
      to: {
        type: 'string',
        description: 'Target branch name',
      },
    },
    required: ['project_id', 'from', 'to'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      comparison: {
        type: 'object',
        properties: {
          commits: { type: 'array' },
          diffs: { type: 'array' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const diff = await gitlab.compareBranches({ project_id: "speedwave/core", from: "main", to: "develop" })`,
  inputExamples: [
    {
      description: 'Compare branches',
      input: { project_id: 'my-group/my-project', from: 'main', to: 'feature/new' },
    },
  ],
  deferLoading: true,
};

/**
 * Execute the compareBranches tool.
 * @param params - Tool parameters
 * @param params.project_id - Project ID or path
 * @param params.from - Base branch name
 * @param params.to - Target branch name
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.compareBranches - Compares two branches
 * @returns Promise resolving to comparison result or error
 */
export async function execute(
  params: { project_id: number | string; from: string; to: string },
  context: { gitlab: { compareBranches: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; comparison?: unknown; error?: string }> {
  const { project_id, from, to } = params;

  if (!project_id || !from || !to) {
    return {
      success: false,
      error: 'Missing required fields: project_id, from, to',
    };
  }

  try {
    const result = await context.gitlab.compareBranches(params);
    return {
      success: true,
      comparison: result,
    };
  } catch (error) {
    return handleExecutionError('compareBranches', params as Record<string, unknown>, error);
  }
}
