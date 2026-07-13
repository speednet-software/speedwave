/**
 * Project Tools - 3 tools for GitLab project operations
 */

import {
  Tool,
  ToolDefinition,
  jsonResult,
  READ_ONLY_ANNOTATIONS,
  META_KEYS,
} from '@speedwave/mcp-shared';
import { GitLabClient } from '../client.js';
import { withValidation } from './validation.js';

const listProjectIdsTool: Tool = {
  name: 'listProjectIds',
  description:
    'List project IDs and paths. Use getProjectFull for details. For "my projects"/"projects I own", pass owned: true.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: true,
    [META_KEYS.USER_SCOPED]: true,
    [META_KEYS.SELF_PARAM]: "owned: true means 'my projects'",
  },
  keywords: ['gitlab', 'projects', 'list', 'repositories', 'repos', 'ids'],
  example: 'const { projects, count } = await gitlab.listProjectIds({ search: "speedwave" })',
  inputSchema: {
    type: 'object',
    properties: {
      membership: { type: 'boolean', description: 'Only member projects (default true)' },
      archived: { type: 'boolean', description: 'Include archived (default false)' },
      search: { type: 'string', description: 'Search by name' },
      owned: {
        type: 'boolean',
        description:
          "Only projects owned by the authenticated user (answers 'my projects'). No separate identity lookup needed.",
      },
      limit: { type: 'number', description: 'Max results (default 20, max 100)' },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      projects: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            name: { type: 'string' },
            path_with_namespace: { type: 'string' },
            web_url: { type: 'string' },
            default_branch: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: list all projects',
      input: {},
    },
    {
      description: 'Partial: search projects',
      input: { search: 'backend' },
    },
    {
      description: 'Full: owned projects only',
      input: { search: 'api', owned: true, limit: 50 },
    },
  ],
};

const getProjectFullTool: Tool = {
  name: 'getProjectFull',
  description: 'Get complete project data. No truncation.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['gitlab', 'project', 'show', 'get', 'detail', 'full'],
  example: 'const project = await gitlab.getProjectFull({ project_id: "speedwave/core" })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      include: {
        type: 'array',
        items: { type: 'string', enum: ['license', 'statistics'] },
        description: 'Additional data',
      },
    },
    required: ['project_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      project: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          name: { type: 'string' },
          description: { type: 'string' },
          path_with_namespace: { type: 'string' },
          web_url: { type: 'string' },
          default_branch: { type: 'string' },
          visibility: { type: 'string' },
          created_at: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'By path',
      input: { project_id: 'my-group/my-project' },
    },
    {
      description: 'By numeric ID',
      input: { project_id: 123 },
    },
  ],
};

const searchCodeTool: Tool = {
  name: 'searchCode',
  description: 'Search for code in GitLab projects',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['gitlab', 'search', 'code', 'find', 'grep', 'regex'],
  example:
    'const results = await gitlab.searchCode({ query: "function authenticate", project_id: "speedwave/core" })',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query string' },
      project_id: {
        type: ['string', 'number'],
        description:
          'Limit search to specific project (optional). Must be the exact path or numeric ID — resolve it first via listProjectIds if you only have a partial project name.',
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
      description: 'Full: search with explicit project path',
      input: { query: 'async.*error', project_id: 'backend-api' },
    },
  ],
};

/**
 * Tool handler function
 * @param client - GitLab client instance
 */
export function createProjectTools(client: GitLabClient | null): ToolDefinition[] {
  return [
    {
      tool: listProjectIdsTool,
      handler: withValidation(client, async (c, params) => {
        const result = await c.listProjects(
          params as {
            search?: string;
            limit?: number;
            owned?: boolean;
            membership?: boolean;
            archived?: boolean;
          }
        );
        return jsonResult({
          projects: result.map((p: { id: number; path_with_namespace: string }) => ({
            id: p.id,
            path: p.path_with_namespace,
          })),
          count: result.length,
        });
      }),
    },
    {
      tool: getProjectFullTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, include = [] } = params as {
          project_id: string | number;
          include?: string[];
        };
        const result = await c.showProject(project_id, {
          license: include.includes('license'),
          statistics: include.includes('statistics'),
        });
        return jsonResult(result);
      }),
    },
    {
      tool: searchCodeTool,
      handler: withValidation(client, async (c, params) => {
        const { query, ...options } = params as { query: string; project_id?: string | number };
        const result = await c.searchCode(query, options);
        return jsonResult(result);
      }),
    },
  ];
}
