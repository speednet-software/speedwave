/**
 * GitLab: Create Tag
 *
 * Create a Git tag in the repository.
 * @param {number|string} project_id - Project ID or path
 * @param {string} tag_name - Tag name (e.g., 'v1.0.0')
 * @param {string} ref - Branch name, commit SHA, or tag to create tag from
 * @param {string} [message] - Tag message (creates annotated tag if provided)
 * @returns {object} Created tag
 * @example
 * // Create tag from main branch
 * const tag = await gitlab.createTag({
 *   project_id: "speedwave/core",
 *   tag_name: "v1.0.0",
 *   ref: "main"
 * });
 *
 * // Create annotated tag
 * const tag = await gitlab.createTag({
 *   project_id: "speedwave/core",
 *   tag_name: "v1.0.0",
 *   ref: "main",
 *   message: "Release v1.0.0 - Initial stable release"
 * });
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'createTag',
  category: 'write',
  description: 'Create a Git tag in the repository',
  keywords: ['gitlab', 'tag', 'create', 'release', 'version', 'git'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: ['string', 'number'],
        description: "Project ID (numeric) or path (e.g., 'group/project')",
      },
      tag_name: { type: 'string', description: "Tag name (e.g., 'v1.0.0')" },
      ref: {
        type: 'string',
        description: "Branch name, commit SHA, or tag to create tag from (e.g., 'master', 'main')",
      },
      message: {
        type: 'string',
        description: 'Tag message (creates annotated tag if provided)',
      },
    },
    required: ['project_id', 'tag_name', 'ref'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      tag: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          message: { type: 'string' },
          target: { type: 'string', description: 'Commit SHA' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const tag = await gitlab.createTag({ project_id: "speedwave/core", tag_name: "v1.0.0", ref: "main", message: "Release v1.0.0 - Initial stable release" })`,
  inputExamples: [
    {
      description: 'Minimal: lightweight tag from main',
      input: { project_id: 'my-group/my-project', tag_name: 'v1.0.0', ref: 'main' },
    },
    {
      description: 'Partial: tag from specific branch',
      input: { project_id: 'web-app', tag_name: 'v2.1.0', ref: 'develop' },
    },
    {
      description: 'Full: annotated tag with message',
      input: {
        project_id: 'backend-api',
        tag_name: 'v1.5.0',
        ref: 'feature/user-auth',
        message: 'Release v1.5.0 - New authentication system',
      },
    },
  ],
  service: 'gitlab',
  deferLoading: true,
};

/**
 * Newly created Git tag information.
 * @interface CreatedTag
 */
interface CreatedTag {
  name: string;
  target: string;
  message?: string;
}

/**
 * Executes the create_tag tool to create a Git tag in the repository.
 * @param params - Tool parameters containing project_id, tag_name, ref, and optional message
 * @param params.project_id - Project ID or path
 * @param params.tag_name - Git tag name
 * @param params.ref - Git reference (branch/tag/commit)
 * @param params.message - Commit or tag message
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.createTag - Function to create tags
 * @returns Promise resolving to created tag information or error
 */
export async function execute(
  params: { project_id: number | string; tag_name: string; ref: string; message?: string },
  context: { gitlab: { createTag: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; tag?: CreatedTag; error?: string }> {
  const { project_id, tag_name, ref } = params;

  if (!project_id || !tag_name || !ref) {
    return {
      success: false,
      error: 'Missing required fields: project_id, tag_name, ref',
    };
  }

  try {
    const result = await context.gitlab.createTag(params);

    return {
      success: true,
      tag: result as CreatedTag,
    };
  } catch (error) {
    return handleExecutionError('createTag', params as Record<string, unknown>, error);
  }
}
