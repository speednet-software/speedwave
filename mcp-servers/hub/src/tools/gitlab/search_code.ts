/**
 * GitLab: Search Code
 *
 * Search code across GitLab projects. Supports regex and filters.
 * @param {string} query - Search query (supports regex)
 * @param {number|string} [project_id] - Limit search to specific project
 * @param {string} [scope="blobs"] - Search scope (blobs, commits, issues, merge_requests, etc.)
 * @returns {object} Search results
 * @example
 * // Search for function
 * const results = await gitlab.searchCode({
 *   query: "function authenticate"
 * });
 *
 * // Search in specific project
 * const results = await gitlab.searchCode({
 *   query: "TODO",
 *   project_id: "speedwave/core"
 * });
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'searchCode',
  category: 'read',
  description: 'Search code across GitLab projects. Supports regex and filters.',
  keywords: ['gitlab', 'search', 'code', 'find', 'grep', 'regex'],
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (supports regex)' },
      project_id: {
        type: ['number', 'string'],
        description: 'Limit search to specific project - ID or path (optional)',
      },
      scope: {
        type: 'string',
        enum: [
          'blobs',
          'commits',
          'issues',
          'merge_requests',
          'milestones',
          'projects',
          'users',
          'wiki_blobs',
        ],
        description: 'Search scope (default: blobs for code search)',
      },
    },
    required: ['query'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            filename: { type: 'string' },
            path: { type: 'string' },
            ref: { type: 'string', description: 'Branch name' },
            startline: { type: 'number' },
            data: { type: 'string', description: 'Matched content' },
            project_id: { type: 'number' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const results = await gitlab.searchCode({ query: "function authenticate", project_id: "speedwave/core" })`,
  inputExamples: [
    {
      description: 'Minimal: search all projects',
      input: { query: 'TODO' },
    },
    {
      description: 'Partial: search in specific project',
      input: { query: 'function authenticate', project_id: 'my-group/my-project' },
    },
    {
      description: 'Full: search with scope',
      input: { query: 'async.*error', project_id: 'backend-api', scope: 'blobs' },
    },
  ],
  service: 'gitlab',
  deferLoading: true,
};

/**
 * Code search result containing file information and matching content.
 * @interface SearchResult
 */
interface SearchResult {
  basename: string;
  data: string;
  path: string;
  filename: string;
  project_id: number;
  ref: string;
}

/**
 * Executes the search_code tool to search code across GitLab projects with regex support.
 * @param params - Tool parameters containing query and optional project_id and scope
 * @param params.query - Search query string
 * @param params.project_id - Project ID or path
 * @param params.scope - Search scope (projects, issues, etc.)
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.searchCode - Function to search code
 * @returns Promise resolving to array of search results or error
 */
export async function execute(
  params: { query: string; project_id?: number | string; scope?: string },
  context: { gitlab: { searchCode: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; results?: SearchResult[]; error?: string }> {
  const { query } = params;

  if (!query) {
    return {
      success: false,
      error: 'Missing required field: query',
    };
  }

  try {
    const result = await context.gitlab.searchCode(params);

    return {
      success: true,
      results: Array.isArray(result) ? result : [],
    };
  } catch (error) {
    return handleExecutionError('searchCode', params as Record<string, unknown>, error);
  }
}
