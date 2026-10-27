/**
 * Jira project tools: listProjects, getProject, listIssueTypes, listComponents. 4 tools.
 * @module mcp-atlassian/tools/jira-project-tools
 */

import {
  type Tool,
  type ToolDefinition,
  jsonResult,
  teachingErrorResult,
  withDeclaredParams,
  META_KEYS,
  READ_ONLY_ANNOTATIONS,
} from '@speedwave/mcp-shared';
import { AtlassianClient } from '../client.js';
import { createJiraProjectsClient } from '../domains/jira-projects.js';
import {
  componentsSchema,
  issueTypesSchema,
  projectSchema,
  projectsSchema,
} from './jira-schemas.js';
import { unconfiguredDefinitions, withValidation } from './validation.js';

const listProjectsTool: Tool = {
  name: 'listProjects',
  description:
    'List Jira projects visible to the account (restricted to the configured project allowlist, if any).',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: false },
  keywords: ['jira', 'projects', 'list', 'browse'],
  example: 'const { projects } = await atlassian.listProjects({ query: "platform" })',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Filter by name/key substring' },
      max_results: { type: 'number', description: 'Max projects (default 50, max 100)' },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      projects: projectsSchema,
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    { description: 'All projects', input: {} },
    { description: 'Search', input: { query: 'mobile' } },
    { description: 'Limit', input: { max_results: 10 } },
  ],
};

const getProjectTool: Tool = {
  name: 'getProject',
  description: 'Get a single Jira project by key or ID.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['jira', 'project', 'get', 'show', 'detail'],
  example: 'const project = await atlassian.getProject({ project: "PROJ" })',
  inputSchema: {
    type: 'object',
    properties: { project: { type: 'string', description: 'Project key or numeric ID' } },
    required: ['project'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      project: projectSchema,
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    { description: 'By key', input: { project: 'PROJ' } },
    { description: 'By ID', input: { project: '10000' } },
  ],
};

const listIssueTypesTool: Tool = {
  name: 'listIssueTypes',
  description:
    'List issue types. Give `project` for the types available in a project, or `issue` for the types that issue can change to (same kind as its current type, sub-task or standard; the current type is excluded). Give exactly one. Restricted to the configured project allowlist, if any (errors if the project is out of scope).',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['jira', 'issue types', 'list', 'project', 'metadata', 'change type'],
  example: 'const { issue_types } = await atlassian.listIssueTypes({ project: "PROJ" })',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Project key or numeric ID' },
      issue: { type: 'string', description: 'Issue key or ID, to list the types it can change to' },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      issue_types: issueTypesSchema,
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    { description: 'Types of a project', input: { project: 'PROJ' } },
    { description: 'Types an issue can change to', input: { issue: 'PROJ-123' } },
  ],
};

const listComponentsTool: Tool = {
  name: 'listComponents',
  description:
    'List the components of a Jira project (id, name, description). Component names are what createIssue and updateIssue take. Restricted to the configured project allowlist, if any.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['jira', 'components', 'list', 'project', 'metadata'],
  example: 'const { components } = await atlassian.listComponents({ project: "PROJ" })',
  inputSchema: {
    type: 'object',
    properties: { project: { type: 'string', description: 'Project key or numeric ID' } },
    required: ['project'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      components: componentsSchema,
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [{ description: 'List components', input: { project: 'PROJ' } }],
};

/**
 * Build the Jira project tool definitions.
 * @param client - The Atlassian client (`null` when not configured).
 */
export function createJiraProjectTools(client: AtlassianClient | null): ToolDefinition[] {
  const tools = [listProjectsTool, getProjectTool, listIssueTypesTool, listComponentsTool];
  if (!client) return unconfiguredDefinitions(tools);
  const projects = createJiraProjectsClient(client);

  const definitions: ToolDefinition[] = [
    {
      tool: listProjectsTool,
      handler: withValidation(client, async (_c, params) => {
        const { query, max_results } = params as { query?: string; max_results?: number };
        return jsonResult({ projects: await projects.list({ query, maxResults: max_results }) });
      }),
    },
    {
      tool: getProjectTool,
      handler: withValidation(client, async (_c, params) => {
        const { project } = params as { project: string };
        return jsonResult({ project: await projects.get(project) });
      }),
    },
    {
      tool: listIssueTypesTool,
      handler: withValidation(client, async (_c, params) => {
        const { project, issue } = params as { project?: string; issue?: string };
        if ((project === undefined) === (issue === undefined)) {
          return teachingErrorResult({
            paramName: 'project or issue',
            nextStep:
              'Give exactly one: project (types available in a project) or issue (types that issue can change to). Nothing was requested.',
          });
        }
        const issueTypes =
          issue !== undefined
            ? await projects.listIssueTypesForIssue(issue)
            : await projects.listIssueTypes(project as string);
        return jsonResult({ issue_types: issueTypes });
      }),
    },
    {
      tool: listComponentsTool,
      handler: withValidation(client, async (_c, params) => {
        const { project } = params as { project: string };
        return jsonResult({ components: await projects.listComponents(project) });
      }),
    },
  ];
  return definitions.map(({ tool, handler }) => ({
    tool,
    handler: withDeclaredParams(tool, handler),
  }));
}
