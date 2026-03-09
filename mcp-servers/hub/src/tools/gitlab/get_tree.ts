/**
 * GitLab: Get Tree
 *
 * Gets repository file tree structure.
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'getTree',
  category: 'read',
  description: 'List files and directories in repository tree',
  keywords: ['gitlab', 'tree', 'files', 'repository', 'ls'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: ['string', 'number'],
        description: 'Project ID or path',
      },
      path: {
        type: 'string',
        description: 'Directory path (default: root)',
      },
      ref: {
        type: 'string',
        description: 'Branch or commit (default: default branch)',
      },
      recursive: {
        type: 'boolean',
        description: 'List recursively',
      },
    },
    required: ['project_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      tree: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            type: { type: 'string' },
            path: { type: 'string' },
            mode: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const tree = await gitlab.getTree({ project_id: "speedwave/core", path: "src" })`,
  inputExamples: [
    {
      description: 'List root directory',
      input: { project_id: 'my-group/my-project' },
    },
    {
      description: 'List specific path',
      input: { project_id: 'my-group/my-project', path: 'src', ref: 'develop' },
    },
  ],
  service: 'gitlab',
  deferLoading: true,
};

/**
 * Execute the getTree tool.
 * @param params - Tool parameters
 * @param params.project_id - Project ID or path
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.getTree - Gets repository tree
 * @returns Promise resolving to tree structure or error
 */
export async function execute(
  params: { project_id: number | string; [key: string]: unknown },
  context: { gitlab: { getTree: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; tree?: unknown[]; error?: string }> {
  const { project_id } = params;

  if (!project_id) {
    return {
      success: false,
      error: 'Missing required field: project_id',
    };
  }

  try {
    const result = await context.gitlab.getTree(params);
    return {
      success: true,
      tree: Array.isArray(result) ? result : [],
    };
  } catch (error) {
    return handleExecutionError('getTree', params as Record<string, unknown>, error);
  }
}
