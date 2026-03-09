/**
 * GitLab: Get File
 *
 * Gets file content from repository with automatic base64 decoding.
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'getFile',
  category: 'read',
  description: 'Get file contents from repository',
  keywords: ['gitlab', 'file', 'content', 'read', 'cat'],
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
      file: {
        type: 'object',
        properties: {
          file_name: { type: 'string' },
          file_path: { type: 'string' },
          size: { type: 'number' },
          encoding: { type: 'string' },
          content: { type: 'string' },
          ref: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const file = await gitlab.getFile({ project_id: "speedwave/core", file_path: "README.md" })`,
  inputExamples: [
    {
      description: 'Get file from default branch',
      input: { project_id: 'my-group/my-project', file_path: 'package.json' },
    },
    {
      description: 'Get file from specific branch',
      input: {
        project_id: 'my-group/my-project',
        file_path: 'src/index.ts',
        ref: 'develop',
      },
    },
  ],
  service: 'gitlab',
  deferLoading: true,
};

/**
 * Execute the getFile tool.
 * @param params - Tool parameters
 * @param params.project_id - Project ID or path
 * @param params.file_path - File path in repository
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.getFile - Gets file contents
 * @returns Promise resolving to file content or error
 */
export async function execute(
  params: { project_id: number | string; file_path: string; [key: string]: unknown },
  context: { gitlab: { getFile: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; file?: unknown; error?: string }> {
  const { project_id, file_path } = params;

  if (!project_id || !file_path) {
    return {
      success: false,
      error: 'Missing required fields: project_id, file_path',
    };
  }

  try {
    const result = await context.gitlab.getFile(params);
    return {
      success: true,
      file: result,
    };
  } catch (error) {
    return handleExecutionError('getFile', params as Record<string, unknown>, error);
  }
}
