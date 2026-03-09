/**
 * GitLab: List Branch Commits
 *
 * List commits from a branch.
 * @param {number|string} project_id - Project ID or path
 * @param {string} branch - Branch name (e.g., 'main', 'develop')
 * @param {number} [limit=20] - Maximum commits to return (max: 100)
 * @returns {object} Array of commits
 * @example
 * // List commits on main branch
 * const commits = await gitlab.listBranchCommits({
 *   project_id: "speedwave/core",
 *   branch: "main"
 * });
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'listBranchCommits',
  category: 'read',
  service: 'gitlab',
  description: 'List commits from a branch',
  keywords: ['gitlab', 'commits', 'branch', 'history', 'log', 'git'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: ['number', 'string'],
        description: "Project ID (numeric) or path (e.g., 'group/project')",
      },
      branch: { type: 'string', description: "Branch name (e.g., 'main', 'develop')" },
      limit: {
        type: 'number',
        description: 'Maximum commits to return (default: 20, max: 100)',
      },
    },
    required: ['project_id', 'branch'],
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
            id: { type: 'string', description: 'Commit SHA' },
            short_id: { type: 'string' },
            title: { type: 'string' },
            message: { type: 'string' },
            author_name: { type: 'string' },
            author_email: { type: 'string' },
            authored_date: { type: 'string' },
            web_url: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const commits = await gitlab.listBranchCommits({ project_id: "speedwave/core", branch: "main" })`,
  inputExamples: [
    {
      description: 'Minimal: list commits from main',
      input: { project_id: 'my-group/my-project', branch: 'main' },
    },
    {
      description: 'Partial: commits from develop branch',
      input: { project_id: 'web-app', branch: 'develop' },
    },
    {
      description: 'Full: limited commits from feature branch',
      input: { project_id: 'backend-api', branch: 'feature/user-auth', limit: 50 },
    },
  ],
  deferLoading: true,
};

/**
 * Commit information from a branch history.
 * @interface Commit
 */
interface Commit {
  id: string;
  short_id: string;
  title: string;
  author_name: string;
  authored_date: string;
  message: string;
}

/**
 * Executes the list_branch_commits tool to retrieve commits from a branch.
 * @param params - Tool parameters containing project_id, branch, and optional limit
 * @param params.project_id - Project ID or path
 * @param params.branch - Branch name
 * @param params.limit - Maximum number of results to return
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.listBranchCommits - Function to list branch commits
 * @returns Promise resolving to array of commits or error
 */
export async function execute(
  params: { project_id: number | string; branch: string; limit?: number },
  context: { gitlab: { listBranchCommits: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; commits?: Commit[]; error?: string }> {
  const { project_id, branch } = params;

  if (!project_id || !branch) {
    return {
      success: false,
      error: 'Missing required fields: project_id, branch',
    };
  }

  try {
    const result = await context.gitlab.listBranchCommits(params);

    return {
      success: true,
      commits: Array.isArray(result) ? result : [],
    };
  } catch (error) {
    return handleExecutionError('listBranchCommits', params as Record<string, unknown>, error);
  }
}
