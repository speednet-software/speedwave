/**
 * Issue Tools - 5 tools for GitLab issue operations
 */

import {
  Tool,
  ToolDefinition,
  jsonResult,
  errorResult,
  notConfiguredMessage,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
} from '@speedwave/mcp-shared';
import { GitLabClient } from '../client.js';
import { withValidation } from './validation.js';

const listIssuesTool: Tool = {
  name: 'listIssues',
  description: 'List project issues',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['gitlab', 'issues', 'list', 'bugs', 'tasks'],
  example:
    'const issues = await gitlab.listIssues({ project_id: "speedwave/core", state: "opened" })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      state: { type: 'string', enum: ['opened', 'closed', 'all'], description: 'Issue state' },
      labels: { type: 'string', description: 'Comma-separated labels' },
      assignee_username: { type: 'string', description: 'Filter by assignee' },
      limit: { type: 'number', description: 'Max results (default 20)' },
    },
    required: ['project_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      issues: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            iid: { type: 'number' },
            title: { type: 'string' },
            state: { type: 'string' },
            labels: { type: 'array' },
            web_url: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'List open issues',
      input: { project_id: 'my-group/my-project', state: 'opened' },
    },
    {
      description: 'List issues by label',
      input: { project_id: 'my-group/my-project', labels: 'bug,urgent' },
    },
  ],
};

const getIssueTool: Tool = {
  name: 'getIssue',
  description: 'Get issue details',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['gitlab', 'issue', 'get', 'show', 'details'],
  example: 'const issue = await gitlab.getIssue({ project_id: "speedwave/core", issue_iid: 42 })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      issue_iid: { type: 'number', description: 'Issue IID' },
    },
    required: ['project_id', 'issue_iid'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      issue: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          iid: { type: 'number' },
          title: { type: 'string' },
          description: { type: 'string' },
          state: { type: 'string' },
          labels: { type: 'array' },
          assignees: { type: 'array' },
          web_url: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Get issue details',
      input: { project_id: 'my-group/my-project', issue_iid: 123 },
    },
  ],
};

const createIssueTool: Tool = {
  name: 'createIssue',
  description: 'Create a new issue',
  annotations: WRITE_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['gitlab', 'issue', 'create', 'new', 'bug'],
  example:
    'const issue = await gitlab.createIssue({ project_id: "speedwave/core", title: "Fix login bug", labels: "bug,urgent" })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      title: { type: 'string', description: 'Issue title' },
      description: { type: 'string', description: 'Issue description' },
      labels: { type: 'string', description: 'Comma-separated labels' },
      assignee_ids: { type: 'array', items: { type: 'number' }, description: 'Assignee user IDs' },
      milestone_id: { type: 'number', description: 'Milestone ID' },
    },
    required: ['project_id', 'title'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      issue: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          iid: { type: 'number' },
          title: { type: 'string' },
          web_url: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Create simple issue',
      input: {
        project_id: 'my-group/my-project',
        title: 'Add feature X',
      },
    },
    {
      description: 'Create detailed issue',
      input: {
        project_id: 'my-group/my-project',
        title: 'Bug: Login fails',
        description: 'Steps to reproduce...',
        labels: 'bug,priority',
      },
    },
  ],
};

const updateIssueTool: Tool = {
  name: 'updateIssue',
  description: 'Update an issue',
  annotations: WRITE_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['gitlab', 'issue', 'update', 'edit', 'modify'],
  example:
    'await gitlab.updateIssue({ project_id: "speedwave/core", issue_iid: 42, title: "Updated title", state_event: "close" })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      issue_iid: { type: 'number', description: 'Issue IID' },
      title: { type: 'string', description: 'New title' },
      description: { type: 'string', description: 'New description' },
      labels: { type: 'string', description: 'Comma-separated labels' },
      state_event: { type: 'string', enum: ['close', 'reopen'], description: 'State event' },
    },
    required: ['project_id', 'issue_iid'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      issue: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          iid: { type: 'number' },
          title: { type: 'string' },
          state: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Update issue title',
      input: {
        project_id: 'my-group/my-project',
        issue_iid: 123,
        title: 'New title',
      },
    },
    {
      description: 'Close issue',
      input: {
        project_id: 'my-group/my-project',
        issue_iid: 123,
        state_event: 'close',
      },
    },
  ],
};

const closeIssueTool: Tool = {
  name: 'closeIssue',
  description: 'Close an issue',
  annotations: WRITE_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['gitlab', 'issue', 'close', 'resolve', 'done'],
  example: 'await gitlab.closeIssue({ project_id: "speedwave/core", issue_iid: 42 })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      issue_iid: { type: 'number', description: 'Issue IID' },
    },
    required: ['project_id', 'issue_iid'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      issue: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          iid: { type: 'number' },
          state: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Close issue',
      input: { project_id: 'my-group/my-project', issue_iid: 123 },
    },
  ],
};

/**
 * Tool handler function
 * @param client - GitLab client instance
 */
export function createIssueTools(client: GitLabClient | null): ToolDefinition[] {
  const unconfigured = async () => errorResult(notConfiguredMessage('GitLab'));
  if (!client) {
    return [
      { tool: listIssuesTool, handler: unconfigured },
      { tool: getIssueTool, handler: unconfigured },
      { tool: createIssueTool, handler: unconfigured },
      { tool: updateIssueTool, handler: unconfigured },
      { tool: closeIssueTool, handler: unconfigured },
    ];
  }

  return [
    {
      tool: listIssuesTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, ...options } = params as {
          project_id: string | number;
          state?: string;
          labels?: string;
          assignee_username?: string;
          limit?: number;
        };
        const result = await c.listIssues(project_id, options);
        return jsonResult(result);
      }),
    },
    {
      tool: getIssueTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, issue_iid } = params as {
          project_id: string | number;
          issue_iid: number;
        };
        const result = await c.getIssue(project_id, issue_iid);
        return jsonResult(result);
      }),
    },
    {
      tool: createIssueTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, ...options } = params as {
          project_id: string | number;
          title: string;
          description?: string;
          labels?: string;
          assignee_ids?: number[];
          milestone_id?: number;
        };
        const result = await c.createIssue(project_id, options);
        return jsonResult(result);
      }),
    },
    {
      tool: updateIssueTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, issue_iid, ...options } = params as {
          project_id: string | number;
          issue_iid: number;
          title?: string;
          description?: string;
          labels?: string;
          state_event?: string;
        };
        const result = await c.updateIssue(project_id, issue_iid, options);
        return jsonResult(result);
      }),
    },
    {
      tool: closeIssueTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, issue_iid } = params as {
          project_id: string | number;
          issue_iid: number;
        };
        const result = await c.closeIssue(project_id, issue_iid);
        return jsonResult(result);
      }),
    },
  ];
}
