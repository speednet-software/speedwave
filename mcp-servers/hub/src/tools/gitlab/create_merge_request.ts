/**
 * GitLab: Create Merge Request
 *
 * Create a new merge request.
 * @param {number|string} project_id - Project ID or path
 * @param {string} source_branch - Source branch name
 * @param {string} target_branch - Target branch name
 * @param {string} title - MR title
 * @param {string} [description] - MR description (supports Markdown)
 * @param {string} [labels] - Comma-separated label names
 * @param {boolean} [remove_source_branch=false] - Delete source branch when merged
 * @returns {object} Created merge request
 * @example
 * // Create MR
 * const mr = await gitlab.createMergeRequest({
 *   project_id: "speedwave/core",
 *   source_branch: "feature/auth",
 *   target_branch: "main",
 *   title: "Add authentication flow"
 * });
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'createMergeRequest',
  category: 'write',
  description: 'Create a new merge request',
  keywords: ['gitlab', 'merge', 'request', 'mr', 'create', 'new', 'pull'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['number', 'string'], description: 'Project ID or path' },
      source_branch: { type: 'string', description: 'Source branch name' },
      target_branch: { type: 'string', description: 'Target branch name' },
      title: { type: 'string', description: 'MR title' },
      description: { type: 'string', description: 'MR description (Markdown)' },
    },
    required: ['project_id', 'source_branch', 'target_branch', 'title'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      merge_request: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          iid: { type: 'number' },
          title: { type: 'string' },
          web_url: { type: 'string' },
          source_branch: { type: 'string' },
          target_branch: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const mr = await gitlab.createMergeRequest({ project_id: "speedwave/core", source_branch: "feature/x", target_branch: "main", title: "Add feature X" })`,
  inputExamples: [
    {
      description: 'Minimal: create MR with required fields',
      input: {
        project_id: 'my-group/my-project',
        source_branch: 'feature/user-auth',
        target_branch: 'main',
        title: 'Add user authentication',
      },
    },
    {
      description: 'Full: create MR with description',
      input: {
        project_id: 'my-group/my-project',
        source_branch: 'feature/user-auth',
        target_branch: 'develop',
        title: 'feat: Add JWT authentication',
        description:
          '## Summary\n\n- Implemented JWT token validation\n- Added refresh token endpoint\n\n## Test Plan\n\n- [x] Unit tests\n- [x] Integration tests',
      },
    },
  ],
  service: 'gitlab',
  deferLoading: true,
};

/**
 * Newly created merge request information.
 * @interface CreatedMR
 */
interface CreatedMR {
  id: number;
  iid: number;
  title: string;
  web_url: string;
}

/**
 * Executes the create_merge_request tool to create a new merge request.
 * @param params - Tool parameters containing project_id, source_branch, target_branch, title, and optional fields
 * @param params.project_id - Project ID or path
 * @param params.source_branch - Source branch name
 * @param params.target_branch - Target branch name
 * @param params.title - Merge request or issue title
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.createMergeRequest - Function to create merge requests
 * @returns Promise resolving to created merge request information or error
 */
export async function execute(
  params: {
    project_id: number | string;
    source_branch: string;
    target_branch: string;
    title: string;
    [key: string]: unknown;
  },
  context: { gitlab: { createMergeRequest: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; merge_request?: CreatedMR; error?: string }> {
  const { project_id, source_branch, target_branch, title } = params;

  if (!project_id || !source_branch || !target_branch || !title) {
    return {
      success: false,
      error: 'Missing required fields: project_id, source_branch, target_branch, title',
    };
  }

  try {
    const result = await context.gitlab.createMergeRequest(params);

    return {
      success: true,
      merge_request: result as CreatedMR,
    };
  } catch (error) {
    return handleExecutionError('createMergeRequest', params as Record<string, unknown>, error);
  }
}
