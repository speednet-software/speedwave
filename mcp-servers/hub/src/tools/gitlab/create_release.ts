/**
 * GitLab: Create Release
 *
 * Create a GitLab release with changelog (requires existing tag).
 * @param {number|string} project_id - Project ID or path
 * @param {string} tag_name - Tag name for the release (must exist)
 * @param {string} [name] - Release name (defaults to tag_name)
 * @param {string} [description] - Release description (supports Markdown, e.g., CHANGELOG content)
 * @returns {object} Created release
 * @example
 * // Create release from existing tag
 * const release = await gitlab.createRelease({
 *   project_id: "speedwave/core",
 *   tag_name: "v1.0.0",
 *   name: "Initial Release",
 *   description: "## Changelog\n- Feature: Authentication\n- Feature: MCP integration"
 * });
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'createRelease',
  category: 'write',
  description: 'Create a GitLab release with changelog (requires existing tag)',
  keywords: ['gitlab', 'release', 'create', 'changelog', 'version', 'publish'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: ['string', 'number'],
        description: "Project ID (numeric) or path (e.g., 'group/project')",
      },
      tag_name: { type: 'string', description: 'Tag name for the release (must exist)' },
      name: { type: 'string', description: 'Release name (defaults to tag_name)' },
      description: {
        type: 'string',
        description: 'Release description (supports Markdown, e.g., CHANGELOG content)',
      },
    },
    required: ['project_id', 'tag_name'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      release: {
        type: 'object',
        properties: {
          tag_name: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          created_at: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const release = await gitlab.createRelease({ project_id: "speedwave/core", tag_name: "v1.0.0", name: "Initial Release", description: "## Changelog\\n- Feature: Authentication\\n- Feature: MCP integration" })`,
  inputExamples: [
    {
      description: 'Minimal: create release with tag only',
      input: { project_id: 'my-group/my-project', tag_name: 'v1.0.0' },
    },
    {
      description: 'Partial: release with custom name',
      input: { project_id: 'web-app', tag_name: 'v2.1.3', name: 'Security Update v2.1.3' },
    },
    {
      description: 'Full: release with changelog',
      input: {
        project_id: 'backend-api',
        tag_name: 'v1.5.0',
        name: 'Release v1.5.0',
        description:
          '## Features\\n- New authentication flow\\n- API rate limiting\\n\\n## Bug Fixes\\n- Fixed memory leak in worker process',
      },
    },
  ],
  service: 'gitlab',
  deferLoading: true,
};

/**
 * Newly created GitLab release information.
 * @interface CreatedRelease
 */
interface CreatedRelease {
  tag_name: string;
  name: string;
  description: string;
  created_at: string;
}

/**
 * Executes the create_release tool to create a GitLab release with changelog.
 * @param params - Tool parameters containing project_id, tag_name, and optional name and description
 * @param params.project_id - Project ID or path
 * @param params.tag_name - Git tag name
 * @param params.name - Name of the resource
 * @param params.description - Description text
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.createRelease - Function to create releases
 * @returns Promise resolving to created release information or error
 */
export async function execute(
  params: { project_id: number | string; tag_name: string; name?: string; description?: string },
  context: { gitlab: { createRelease: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; release?: CreatedRelease; error?: string }> {
  const { project_id, tag_name } = params;

  if (!project_id || !tag_name) {
    return {
      success: false,
      error: 'Missing required fields: project_id, tag_name',
    };
  }

  try {
    const result = await context.gitlab.createRelease(params);

    return {
      success: true,
      release: result as CreatedRelease,
    };
  } catch (error) {
    return handleExecutionError('createRelease', params as Record<string, unknown>, error);
  }
}
