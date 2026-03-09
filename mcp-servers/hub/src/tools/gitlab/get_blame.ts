/**
 * GitLab: Get Blame
 *
 * Gets git blame information showing who last modified each line.
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'getBlame',
  category: 'read',
  description: 'Get git blame information for a file',
  keywords: ['gitlab', 'blame', 'annotate', 'history', 'git'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: ['string', 'number'],
        description: 'Project ID or path',
      },
      file_path: {
        type: 'string',
        description: 'File path in repository',
      },
      ref: {
        type: 'string',
        description: 'Branch or commit (default: default branch)',
      },
    },
    required: ['project_id', 'file_path'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      blame: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            commit: { type: 'object' },
            lines: { type: 'array' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const blame = await gitlab.getBlame({ project_id: "speedwave/core", file_path: "src/index.ts" })`,
  inputExamples: [
    {
      description: 'Get blame for file',
      input: { project_id: 'my-group/my-project', file_path: 'src/main.js' },
    },
  ],
  service: 'gitlab',
  deferLoading: true,
};

/**
 * Execute the getBlame tool.
 * @param params - Tool parameters
 * @param params.project_id - Project ID or path
 * @param params.file_path - File path in repository
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.getBlame - Gets file blame information
 * @returns Promise resolving to blame data or error
 */
export async function execute(
  params: { project_id: number | string; file_path: string; [key: string]: unknown },
  context: { gitlab: { getBlame: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; blame?: unknown[]; error?: string }> {
  const { project_id, file_path } = params;

  if (!project_id || !file_path) {
    return {
      success: false,
      error: 'Missing required fields: project_id, file_path',
    };
  }

  try {
    const result = await context.gitlab.getBlame(params);
    return {
      success: true,
      blame: Array.isArray(result) ? result : [],
    };
  } catch (error) {
    return handleExecutionError('getBlame', params as Record<string, unknown>, error);
  }
}
