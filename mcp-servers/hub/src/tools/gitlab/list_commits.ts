/**
 * GitLab: List Commits
 *
 * Lists commits in a repository with optional filters.
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'listCommits',
  category: 'read',
  service: 'gitlab',
  description: 'List commits in a repository',
  keywords: ['gitlab', 'commits', 'history', 'log', 'git'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: ['string', 'number'],
        description: 'Project ID or path',
      },
      ref: {
        type: 'string',
        description: 'Branch or tag name',
      },
      since: {
        type: 'string',
        description: 'Only commits after date (ISO 8601)',
      },
      until: {
        type: 'string',
        description: 'Only commits before date (ISO 8601)',
      },
      path: {
        type: 'string',
        description: 'File path to filter commits',
      },
      limit: {
        type: 'number',
        description: 'Max results (default 20)',
      },
    },
    required: ['project_id'],
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
            created_at: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const commits = await gitlab.listCommits({ project_id: "speedwave/core", ref: "main", limit: 10 })`,
  inputExamples: [
    {
      description: 'List recent commits',
      input: { project_id: 'my-group/my-project', ref: 'main' },
    },
    {
      description: 'List commits for specific file',
      input: {
        project_id: 'my-group/my-project',
        ref: 'main',
        path: 'src/index.ts',
      },
    },
  ],
  deferLoading: true,
};

/**
 * Execute the listCommits tool.
 * @param params - Tool parameters
 * @param params.project_id - Project ID or path
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.listCommits - Lists repository commits
 * @returns Promise resolving to commits list or error
 */
export async function execute(
  params: { project_id: number | string; [key: string]: unknown },
  context: { gitlab: { listCommits: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; commits?: unknown[]; error?: string }> {
  const { project_id } = params;

  if (!project_id) {
    return {
      success: false,
      error: 'Missing required field: project_id',
    };
  }

  try {
    const result = await context.gitlab.listCommits(params);
    return {
      success: true,
      commits: Array.isArray(result) ? result : [],
    };
  } catch (error) {
    return handleExecutionError('listCommits', params as Record<string, unknown>, error);
  }
}
