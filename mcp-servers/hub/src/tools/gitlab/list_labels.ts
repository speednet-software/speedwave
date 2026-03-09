/**
 * GitLab: List Labels
 *
 * Lists labels in a project.
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'listLabels',
  category: 'read',
  description: 'List all labels in a project',
  keywords: ['gitlab', 'labels', 'list', 'tags'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: ['string', 'number'],
        description: 'Project ID or path',
      },
    },
    required: ['project_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      labels: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            name: { type: 'string' },
            color: { type: 'string' },
            description: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const labels = await gitlab.listLabels({ project_id: "speedwave/core" })`,
  inputExamples: [
    {
      description: 'List project labels',
      input: { project_id: 'my-group/my-project' },
    },
  ],
  service: 'gitlab',
  deferLoading: true,
};

/**
 * Execute the listLabels tool.
 * @param params - Tool parameters
 * @param params.project_id - Project ID or path
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.listLabels - Lists project labels
 * @returns Promise resolving to labels list or error
 */
export async function execute(
  params: { project_id: number | string },
  context: { gitlab: { listLabels: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; labels?: unknown[]; error?: string }> {
  const { project_id } = params;

  if (!project_id) {
    return {
      success: false,
      error: 'Missing required field: project_id',
    };
  }

  try {
    const result = await context.gitlab.listLabels(params);
    return {
      success: true,
      labels: Array.isArray(result) ? result : [],
    };
  } catch (error) {
    return handleExecutionError('listLabels', params as Record<string, unknown>, error);
  }
}
