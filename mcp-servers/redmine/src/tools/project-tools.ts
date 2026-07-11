/**
 * Project Tools - 3 tools for Redmine project operations
 */

import {
  Tool,
  ToolDefinition,
  jsonResult,
  errorResult,
  notConfiguredMessage,
  READ_ONLY_ANNOTATIONS,
  META_KEYS,
} from '@speedwave/mcp-shared';
import { RedmineClient } from '../client.js';
import { withRedmineErrors } from './error-handling.js';
import { successResultSchema } from './schema-helpers.js';

const listProjectIdsTool: Tool = {
  name: 'listProjectIds',
  description:
    'List project IDs with optional filters. Returns only IDs for efficiency. If this Redmine integration is scoped to a single project, this always returns just that one project regardless of limit/offset.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['redmine', 'projects', 'list', 'ids', 'filter', 'active', 'closed'],
  example: `const { ids } = await redmine.listProjectIds({ status: 'active' })`,
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['active', 'closed', 'archived', 'all'],
        description: 'Project status filter',
      },
      limit: { type: 'number', description: 'Max results (default 100)' },
      offset: { type: 'number', description: 'Pagination offset' },
    },
  },
  outputSchema: successResultSchema({
    ids: { type: 'array', items: { type: 'number' } },
    identifiers: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'number' }, identifier: { type: 'string' } },
      },
    },
    total_count: { type: 'number' },
    offset: { type: 'number' },
    limit: { type: 'number' },
  }),
  inputExamples: [
    {
      description: 'Minimal: list all projects',
      input: {},
    },
    {
      description: 'Partial: active projects only',
      input: { status: 'active' },
    },
    {
      description: 'Full: paginated active projects',
      input: { status: 'active', limit: 10, offset: 0 },
    },
  ],
};

const getProjectFullTool: Tool = {
  name: 'getProjectFull',
  description:
    'Get complete project data including trackers, categories, modules. No truncation. If scoped to a single project, requesting a different project_id fails with a scope error.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['redmine', 'project', 'details', 'full', 'trackers', 'categories', 'modules'],
  example: `const project = await redmine.getProjectFull({ project_id: 'my-project' })`,
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: ['string', 'number'],
        description: 'Project ID or identifier — obtained from listProjectIds or searchProjectIds',
      },
      include: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'trackers',
            'issue_categories',
            'enabled_modules',
            'time_entry_activities',
            'issue_custom_fields',
          ],
        },
        description: 'Additional data to include',
      },
    },
    required: ['project_id'],
  },
  outputSchema: successResultSchema({
    project: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        identifier: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'number' },
        is_public: { type: 'boolean' },
        created_on: { type: 'string' },
        updated_on: { type: 'string' },
      },
    },
  }),
  inputExamples: [
    {
      description: 'Minimal: get basic project data',
      input: { project_id: 'my-project' },
    },
    {
      description: 'Full: get project with trackers and categories',
      input: { project_id: 'my-project', include: ['trackers', 'issue_categories'] },
    },
  ],
};

const searchProjectIdsTool: Tool = {
  name: 'searchProjectIds',
  description:
    'Search projects by name, identifier or description. Returns matching IDs only. If scoped to a single project, only that project is searched.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['redmine', 'projects', 'search', 'find', 'query', 'name'],
  example: `const { ids } = await redmine.searchProjectIds({ query: 'mobile' })`,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      limit: { type: 'number', description: 'Max results (default 25)' },
    },
    required: ['query'],
  },
  outputSchema: successResultSchema({
    ids: { type: 'array', items: { type: 'number' } },
    projects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          identifier: { type: 'string' },
          name: { type: 'string' },
        },
      },
    },
    total_count: { type: 'number' },
  }),
  inputExamples: [
    {
      description: 'Minimal: search all projects',
      input: { query: 'mobile' },
    },
    {
      description: 'Full: search with limit',
      input: { query: 'mobile', limit: 10 },
    },
  ],
};

/**
 * Tool handler function
 * @param client - Redmine client instance
 */
export function createProjectTools(client: RedmineClient | null): ToolDefinition[] {
  const unconfigured = async () => errorResult(notConfiguredMessage('Redmine'));
  if (!client) {
    return [
      { tool: listProjectIdsTool, handler: unconfigured },
      { tool: getProjectFullTool, handler: unconfigured },
      { tool: searchProjectIdsTool, handler: unconfigured },
    ];
  }

  return [
    {
      tool: listProjectIdsTool,
      handler: async (params) =>
        withRedmineErrors(undefined, async () => {
          const { status, limit, offset } = params as {
            status?: 'active' | 'closed' | 'archived' | 'all';
            limit?: number;
            offset?: number;
          };
          const result = await client.listProjects({ status, limit, offset });
          return jsonResult({
            ids: result.projects.map((p: { id: number }) => p.id),
            identifiers: result.projects.map((p: { id: number; identifier: string }) => ({
              id: p.id,
              identifier: p.identifier,
            })),
            total_count: result.total_count,
            offset: offset || 0,
            limit: limit || 100,
          });
        }),
    },
    {
      tool: getProjectFullTool,
      handler: async (params) => {
        const { project_id, include = [] } = params as {
          project_id: string | number;
          include?: string[];
        };
        return withRedmineErrors({ project_id }, async () => {
          const result = await client.showProject(project_id, { include });
          return jsonResult(result);
        });
      },
    },
    {
      tool: searchProjectIdsTool,
      handler: async (params) =>
        withRedmineErrors(undefined, async () => {
          const { query, limit } = params as { query: string; limit?: number };
          const result = await client.searchProjects(query, { limit });
          return jsonResult({
            ids: result.projects.map((p: { id: number }) => p.id),
            projects: result.projects,
            total_count: result.total_count,
          });
        }),
    },
  ];
}
