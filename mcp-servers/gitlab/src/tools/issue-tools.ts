/**
 * Issue Tools - 5 tools for GitLab issue operations
 */

import { Tool, ToolDefinition, jsonResult, errorResult } from '../../../shared/dist/index.js';
import { GitLabClient } from '../client.js';
import { withValidation } from './validation.js';

const listIssuesTool: Tool = {
  name: 'listIssues',
  description: 'List project issues',
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
};

const getIssueTool: Tool = {
  name: 'getIssue',
  description: 'Get issue details',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      issue_iid: { type: 'number', description: 'Issue IID' },
    },
    required: ['project_id', 'issue_iid'],
  },
};

const createIssueTool: Tool = {
  name: 'createIssue',
  description: 'Create a new issue',
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
};

const updateIssueTool: Tool = {
  name: 'updateIssue',
  description: 'Update an issue',
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
};

const closeIssueTool: Tool = {
  name: 'closeIssue',
  description: 'Close an issue',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      issue_iid: { type: 'number', description: 'Issue IID' },
    },
    required: ['project_id', 'issue_iid'],
  },
};

/**
 * Tool handler function
 * @param client - GitLab client instance
 */
export function createIssueTools(client: GitLabClient | null): ToolDefinition[] {
  const unconfigured = async () =>
    errorResult('GitLab not configured. Run: speedwave setup gitlab');
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
