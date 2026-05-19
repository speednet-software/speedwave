/**
 * Jira project tools — listProjects, getProject, listIssueTypes. 3 tools.
 * @module mcp-atlassian/tools/jira-project-tools
 */

import {
  type Tool,
  type ToolDefinition,
  jsonResult,
  errorResult,
  notConfiguredMessage,
  READ_ONLY_ANNOTATIONS,
} from '@speedwave/mcp-shared';
import { AtlassianClient } from '../client.js';
import { createJiraProjectsClient } from '../domains/jira-projects.js';
import { withValidation } from './validation.js';

const listProjectsTool: Tool = {
  name: 'listProjects',
  description:
    'List Jira projects visible to the account (restricted to the configured project allowlist, if any).',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: false },
  keywords: ['jira', 'projects', 'list', 'browse'],
  example: 'const { projects } = await atlassian.listProjects({ query: "platform" })',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Filter by name/key substring' },
      maxResults: { type: 'number', description: 'Max projects (default 50, max 100)' },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      projects: { type: 'array' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    { description: 'All projects', input: {} },
    { description: 'Search', input: { query: 'mobile' } },
    { description: 'Limit', input: { maxResults: 10 } },
  ],
};

const getProjectTool: Tool = {
  name: 'getProject',
  description: 'Get a single Jira project by key or ID.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['jira', 'project', 'get', 'show', 'detail'],
  example: 'const project = await atlassian.getProject({ projectIdOrKey: "PROJ" })',
  inputSchema: {
    type: 'object',
    properties: { projectIdOrKey: { type: 'string', description: 'Project key or numeric ID' } },
    required: ['projectIdOrKey'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      project: { type: 'object' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    { description: 'By key', input: { projectIdOrKey: 'PROJ' } },
    { description: 'By ID', input: { projectIdOrKey: '10000' } },
  ],
};

const listIssueTypesTool: Tool = {
  name: 'listIssueTypes',
  description: 'List the issue types available in a Jira project.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['jira', 'issue types', 'list', 'project', 'metadata'],
  example: 'const { issue_types } = await atlassian.listIssueTypes({ projectIdOrKey: "PROJ" })',
  inputSchema: {
    type: 'object',
    properties: { projectIdOrKey: { type: 'string', description: 'Project key or numeric ID' } },
    required: ['projectIdOrKey'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      issue_types: { type: 'array' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [{ description: 'List issue types', input: { projectIdOrKey: 'PROJ' } }],
};

/**
 * Build the Jira project tool definitions.
 * @param client - The Atlassian client (`null` when not configured).
 * @returns Tool definitions for projects.
 */
export function createJiraProjectTools(client: AtlassianClient | null): ToolDefinition[] {
  const tools = [listProjectsTool, getProjectTool, listIssueTypesTool];
  if (!client) {
    const unconfigured = async () => errorResult(notConfiguredMessage('Atlassian'));
    return tools.map((tool) => ({ tool, handler: unconfigured }));
  }
  const projects = createJiraProjectsClient(client);

  return [
    {
      tool: listProjectsTool,
      handler: withValidation(client, async (_c, params) => {
        const { query, maxResults } = params as { query?: string; maxResults?: number };
        return jsonResult({ projects: await projects.list({ query, maxResults }) });
      }),
    },
    {
      tool: getProjectTool,
      handler: withValidation(client, async (_c, params) => {
        const { projectIdOrKey } = params as { projectIdOrKey: string };
        return jsonResult({ project: await projects.get(projectIdOrKey) });
      }),
    },
    {
      tool: listIssueTypesTool,
      handler: withValidation(client, async (_c, params) => {
        const { projectIdOrKey } = params as { projectIdOrKey: string };
        return jsonResult({ issue_types: await projects.listIssueTypes(projectIdOrKey) });
      }),
    },
  ];
}
