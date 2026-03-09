/**
 * Redmine: Search Issues
 *
 * Full-text search for issue IDs.
 * Supports operators: #123, author:name, priority:high
 * @param {string} query - Search query (full-text)
 * @param {string} [project_id] - Limit search to specific project
 * @param {number} [limit=25] - Maximum results
 * @returns {object} Array of matching issues
 * @example
 * // Search for authentication issues
 * const { ids, total_count } = await redmine.searchIssueIds({
 *   query: "authentication error"
 * });
 *
 * // Search in specific project
 * const projectResults = await redmine.searchIssueIds({
 *   query: "priority:high author:john",
 *   project_id: "my-project"
 * });
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'searchIssueIds',
  category: 'read',
  service: 'redmine',
  description:
    'Full-text search for issue IDs. Supports operators: #123, author:name, priority:high',
  keywords: ['redmine', 'issue', 'search', 'find', 'query', 'ids'],
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (full-text)' },
      project_id: { type: 'string', description: 'Limit to specific project' },
      limit: { type: 'number', description: 'Maximum results (default: 25)' },
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
            id: { type: 'number' },
            subject: { type: 'string' },
            status: { type: 'object', properties: { name: { type: 'string' } } },
            project: { type: 'object', properties: { name: { type: 'string' } } },
          },
        },
      },
      total_count: { type: 'number' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const { ids, total_count } = await redmine.searchIssueIds({ query: "authentication error", project_id: "my-project" })`,
  inputExamples: [
    {
      description: 'Minimal: search all projects',
      input: { query: 'authentication error' },
    },
    {
      description: 'Partial: search in project',
      input: { query: 'login fails', project_id: 'my-project' },
    },
    {
      description: 'Full: search with limit',
      input: { query: 'priority:high author:john', project_id: 'my-project', limit: 50 },
    },
  ],
  deferLoading: true,
};

/**
 * Search result for an issue.
 * @interface SearchResult
 */
interface SearchResult {
  /** Issue ID */
  id: number;
  /** Issue subject/title */
  subject: string;
  /** Issue status information */
  status: { id: number; name: string };
  /** Project information */
  project: { id: number; name: string };
}

/**
 * Execute the search_issues tool.
 * @param params - Tool parameters including search query and optional filters
 * @param params.query - Search query string
 * @param params.project_id - Project ID or path
 * @param params.limit - Maximum number of results to return
 * @param context - Execution context with Redmine client
 * @param context.redmine - Redmine service bridge instance
 * @param context.redmine.searchIssues - Function to search issues
 * @returns Promise resolving to array of matching issues or error
 */
export async function execute(
  params: { query: string; project_id?: string; limit?: number },
  context: { redmine: { searchIssues: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; results?: SearchResult[]; error?: string }> {
  const { query } = params;

  if (!query) {
    return {
      success: false,
      error: 'Missing required field: query',
    };
  }

  try {
    const result = await context.redmine.searchIssues(params);
    const data = result as { results?: SearchResult[] };

    return {
      success: true,
      results: data.results || [],
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
