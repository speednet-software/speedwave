/**
 * Project Tools - 3 tools for GitLab project operations
 */

import {
  Tool,
  ToolDefinition,
  jsonResult,
  errorResult,
  notConfiguredMessage,
} from '@speedwave/mcp-shared';
import { GitLabClient } from '../client.js';
import { withValidation } from './validation.js';

const listProjectIdsTool: Tool = {
  name: 'listProjectIds',
  description: 'List project IDs and paths. Use get_project_full for details.',
  category: 'read',
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  keywords: ['gitlab', 'projects', 'list', 'repositories', 'repos', 'ids'],
  example: 'const { projects, count } = await gitlab.listProjectIds({ search: "speedwave" })',
  inputSchema: {
    type: 'object',
    properties: {
      membership: { type: 'boolean', description: 'Only member projects (default true)' },
      archived: { type: 'boolean', description: 'Include archived (default false)' },
      search: { type: 'string', description: 'Search by name' },
      limit: { type: 'number', description: 'Max results (default 100)' },
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
  category: 'read',
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
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
  category: 'read',
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  keywords: ['gitlab', 'search', 'code', 'find', 'grep', 'regex'],
  example:
    'const results = await gitlab.searchCode({ query: "function authenticate", project_id: "speedwave/core" })',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query string' },
      project_id: {
        type: ['string', 'number'],
        description: 'Limit search to specific project (optional)',
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
      description: 'Full: search with scope',
      input: { query: 'async.*error', project_id: 'backend-api', scope: 'blobs' },
    },
  ],
};

/**
 * Tool handler function
 * @param client - GitLab client instance
 */
export function createProjectTools(client: GitLabClient | null): ToolDefinition[] {
  const unconfigured = async () => errorResult(notConfiguredMessage('GitLab'));
  if (!client) {
    return [
      { tool: listProjectIdsTool, handler: unconfigured },
      { tool: getProjectFullTool, handler: unconfigured },
      { tool: searchCodeTool, handler: unconfigured },
    ];
  }

  return [
    {
      tool: listProjectIdsTool,
      handler: withValidation(client, async (c, params) => {
        const result = await c.listProjects(
          params as { search?: string; limit?: number; owned?: boolean }
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
