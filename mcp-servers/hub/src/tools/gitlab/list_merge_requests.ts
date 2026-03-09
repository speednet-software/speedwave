/**
 * GitLab: List Merge Requests
 *
 * List merge requests from a GitLab project with filters.
 * @param {number|string} project_id - Project ID or path
 * @param {string} [state="opened"] - MR state filter (opened, closed, merged, all)
 * @param {string} [author_username] - Filter by author username
 * @param {string} [reviewer_username] - Filter by reviewer username
 * @param {string} [labels] - Comma-separated label names
 * @param {number} [limit=20] - Maximum MRs to return (max: 100)
 * @returns {object} Array of merge requests
 * @example
 * // List open MRs
 * const mrs = await gitlab.listMergeRequests({
 *   project_id: "speedwave/core"
 * });
 *
 * // List my MRs
 * const myMrs = await gitlab.listMergeRequests({
 *   project_id: "speedwave/core",
 *   author_username: "alice"
 * });
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'listMrIds',
  category: 'read',
  description: 'List merge request IDs from a GitLab project with filters',
  keywords: ['gitlab', 'merge', 'request', 'mr', 'list', 'pull', 'ids'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['number', 'string'], description: 'Project ID or path' },
      state: {
        type: 'string',
        enum: ['opened', 'closed', 'merged', 'all'],
        description: 'MR state filter',
      },
      author_username: { type: 'string', description: 'Filter by author' },
      limit: { type: 'number', description: 'Maximum MRs (default: 20, max: 100)' },
    },
    required: ['project_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      merge_requests: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            iid: { type: 'number', description: 'Internal ID within project' },
            title: { type: 'string' },
            state: { type: 'string', enum: ['opened', 'closed', 'merged'] },
            source_branch: { type: 'string' },
            target_branch: { type: 'string' },
            author: { type: 'object', properties: { username: { type: 'string' } } },
            web_url: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const { mrs, count } = await gitlab.listMrIds({ project_id: "speedwave/core", state: "opened" })`,
  inputExamples: [
    {
      description: 'Minimal: all MRs for project',
      input: { project_id: 'my-group/my-project' },
    },
    {
      description: 'Partial: open MRs only',
      input: { project_id: 'my-group/my-project', state: 'opened' },
    },
    {
      description: 'Full: my open MRs',
      input: {
        project_id: 'my-group/my-project',
        state: 'opened',
        author_username: 'john.doe',
        limit: 50,
      },
    },
  ],
  service: 'gitlab',
  deferLoading: false,
};

/**
 * Merge request summary information for listing and filtering.
 * @interface MergeRequest
 */
interface MergeRequest {
  id: number;
  iid: number;
  title: string;
  state: string;
  source_branch: string;
  target_branch: string;
  author: { username: string };
  web_url: string;
}

/**
 * Executes the list_merge_requests tool to retrieve filtered merge requests.
 * @param params - Tool parameters containing project_id and optional filters (state, author_username, reviewer_username, labels, limit)
 * @param params.project_id - Project ID or path
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.listMergeRequests - Function to list merge requests
 * @returns Promise resolving to array of merge requests or error
 */
export async function execute(
  params: { project_id: number | string; [key: string]: unknown },
  context: { gitlab: { listMergeRequests: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; merge_requests?: MergeRequest[]; error?: string }> {
  const { project_id } = params;

  if (!project_id) {
    return {
      success: false,
      error: 'Missing required field: project_id',
    };
  }

  try {
    const result = await context.gitlab.listMergeRequests(params);

    return {
      success: true,
      merge_requests: Array.isArray(result) ? result : [],
    };
  } catch (error) {
    return handleExecutionError('listMrIds', params as Record<string, unknown>, error);
  }
}
