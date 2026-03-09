/**
 * GitLab: Delete Tag
 *
 * Deletes a Git tag from the repository.
 * @param {number|string} project_id - Project ID or path
 * @param {string} tag_name - Tag name to delete (e.g., 'v1.0.0')
 * @returns {Promise<{success: boolean, message?: string, error?: string}>} Deletion result
 * @example
 * // Delete a tag
 * await gitlab.deleteTag({
 *   project_id: "speedwave/core",
 *   tag_name: "v1.0.0"
 * });
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'deleteTag',
  category: 'delete',
  service: 'gitlab',
  description: 'Delete a Git tag from the repository',
  keywords: ['gitlab', 'tag', 'delete', 'remove', 'git', 'version', 'release'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: ['string', 'number'],
        description: "Project ID (numeric) or path (e.g., 'group/project')",
      },
      tag_name: {
        type: 'string',
        description: "Tag name to delete (e.g., 'v1.0.0')",
      },
    },
    required: ['project_id', 'tag_name'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      message: { type: 'string' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `await gitlab.deleteTag({ project_id: "speedwave/core", tag_name: "v1.0.0" })`,
  inputExamples: [
    {
      description: 'Delete tag by project path',
      input: { project_id: 'my-group/my-project', tag_name: 'v1.0.0' },
    },
    {
      description: 'Delete tag by project ID',
      input: { project_id: 123, tag_name: 'v0.0.1-test' },
    },
  ],
  deferLoading: true,
};

/**
 * Execute the deleteTag tool.
 * @param params - Tool parameters
 * @param params.project_id - Project ID or path
 * @param params.tag_name - Tag name to delete
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.deleteTag - Deletes a tag
 * @returns Promise resolving to success status or error
 */
export async function execute(
  params: { project_id: number | string; tag_name: string },
  context: { gitlab: { deleteTag: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; message?: string; error?: string }> {
  const { project_id, tag_name } = params;

  if (!project_id || !tag_name?.trim()) {
    return {
      success: false,
      error: 'Missing required fields: project_id, tag_name',
    };
  }

  if (tag_name.includes(' ')) {
    return {
      success: false,
      error: `Invalid tag name '${tag_name}': Tag names cannot contain spaces`,
    };
  }

  try {
    await context.gitlab.deleteTag(params);
    return { success: true, message: `Tag '${tag_name}' deleted successfully` };
  } catch (error) {
    return handleExecutionError('deleteTag', params as Record<string, unknown>, error);
  }
}
