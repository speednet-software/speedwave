/**
 * GitLab: Search Commits
 *
 * Searches commits by message content.
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'searchCommits',
  category: 'read',
  service: 'gitlab',
  description: 'Search commits by message',
  keywords: ['gitlab', 'commits', 'search', 'find', 'git'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: ['string', 'number'],
        description: 'Project ID or path',
      },
      query: {
        type: 'string',
        description: 'Search query',
      },
      ref: {
        type: 'string',
        description: 'Branch or tag name',
      },
      limit: {
        type: 'number',
        description: 'Max results (default 20)',
      },
    },
    required: ['project_id', 'query'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      commits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            message: { type: 'string' },
            author_name: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const commits = await gitlab.searchCommits({ project_id: "speedwave/core", query: "fix bug" })`,
  inputExamples: [
    {
      description: 'Search commits',
      input: { project_id: 'my-group/my-project', query: 'refactor' },
    },
  ],
  deferLoading: true,
};

/**
 * Execute the searchCommits tool.
 * @param params - Tool parameters
 * @param params.project_id - Project ID or path
 * @param params.query - Search query
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.searchCommits - Searches commits by message
 * @returns Promise resolving to matching commits or error
 */
export async function execute(
  params: { project_id: number | string; query: string; [key: string]: unknown },
  context: { gitlab: { searchCommits: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; commits?: unknown[]; error?: string }> {
  const { project_id, query } = params;

  if (!project_id || !query) {
    return {
      success: false,
      error: 'Missing required fields: project_id, query',
    };
  }

  try {
    const result = await context.gitlab.searchCommits(params);
    return {
      success: true,
      commits: Array.isArray(result) ? result : [],
    };
  } catch (error) {
    return handleExecutionError('searchCommits', params as Record<string, unknown>, error);
  }
}
