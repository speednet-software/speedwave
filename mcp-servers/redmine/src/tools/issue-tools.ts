/**
 * Issue Tools - 6 tools for Redmine issue operations
 */

import { Tool, ToolDefinition, jsonResult, errorResult } from '../../../shared/dist/index.js';
import { RedmineClient } from '../client.js';
import { resolveParams } from './helpers.js';

// Tool Definitions
const listIssueIdsTool: Tool = {
  name: 'listIssueIds',
  description: 'List issue IDs with optional filters. Returns only IDs for efficiency.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'Project identifier or key' },
      status: { type: 'string', description: 'Status: open, closed, * (all)' },
      assigned_to: { type: 'string', description: 'Assignee: me, user_id, or username' },
      tracker_id: { type: 'number', description: 'Tracker ID' },
      priority_id: { type: 'number', description: 'Priority ID' },
      limit: { type: 'number', description: 'Max results (default 100)' },
      offset: { type: 'number', description: 'Pagination offset' },
    },
  },
};

const getIssueFullTool: Tool = {
  name: 'getIssueFull',
  description: 'Get complete issue data including custom_fields, relations. No truncation.',
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'number', description: 'Issue ID' },
      include: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional data to include',
      },
    },
    required: ['issue_id'],
  },
};

const searchIssueIdsTool: Tool = {
  name: 'searchIssueIds',
  description: 'Search issues by text query. Returns matching IDs only.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      project_id: { type: 'string', description: 'Limit to project' },
      limit: { type: 'number', description: 'Max results (default 25)' },
    },
    required: ['query'],
  },
};

const createIssueTool: Tool = {
  name: 'createIssue',
  description: 'Create a new Redmine issue',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'Project ID or identifier' },
      subject: { type: 'string', description: 'Issue subject/title' },
      description: { type: 'string', description: 'Issue description' },
      tracker_id: { type: 'number', description: 'Tracker ID' },
      tracker: { type: 'string', description: 'Tracker name' },
      status_id: { type: 'number', description: 'Status ID' },
      status: { type: 'string', description: 'Status name' },
      priority_id: { type: 'number', description: 'Priority ID' },
      priority: { type: 'string', description: 'Priority name' },
      assigned_to_id: { type: 'number', description: 'Assigned user ID' },
      assigned_to: { type: 'string', description: 'Assignee name' },
      parent_issue_id: { type: 'number', description: 'Parent issue ID' },
      estimated_hours: { type: 'number', description: 'Estimated hours' },
    },
    required: ['project_id', 'subject'],
  },
};

const updateIssueTool: Tool = {
  name: 'updateIssue',
  description: 'Update an existing Redmine issue',
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'number', description: 'Issue ID to update' },
      subject: { type: 'string', description: 'New subject' },
      description: { type: 'string', description: 'New description' },
      status_id: { type: 'number', description: 'Status ID' },
      status: { type: 'string', description: 'Status name' },
      priority_id: { type: 'number', description: 'Priority ID' },
      assigned_to_id: { type: 'number', description: 'Assigned user ID' },
      notes: { type: 'string', description: 'Update notes/comment' },
    },
    required: ['issue_id'],
  },
};

const commentIssueTool: Tool = {
  name: 'commentIssue',
  description: 'Add a comment to an issue',
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'number', description: 'Issue ID' },
      notes: { type: 'string', description: 'Comment text' },
    },
    required: ['issue_id', 'notes'],
  },
};

/**
 * Tool handler function
 * @param client - Redmine client instance
 */
export function createIssueTools(client: RedmineClient | null): ToolDefinition[] {
  const unconfigured = async () =>
    errorResult('Redmine not configured. Run: speedwave setup redmine');
  if (!client) {
    return [
      { tool: listIssueIdsTool, handler: unconfigured },
      { tool: getIssueFullTool, handler: unconfigured },
      { tool: searchIssueIdsTool, handler: unconfigured },
      { tool: createIssueTool, handler: unconfigured },
      { tool: updateIssueTool, handler: unconfigured },
      { tool: commentIssueTool, handler: unconfigured },
    ];
  }

  return [
    {
      tool: listIssueIdsTool,
      handler: async (params) => {
        try {
          const p = params as Record<string, unknown>;
          const specialStatuses = ['open', 'closed', '*'];
          const statusValue = p.status as string | undefined;
          let resolved: Record<string, unknown>;
          if (statusValue && specialStatuses.includes(statusValue)) {
            resolved = { ...p, status_id: statusValue };
            delete resolved.status;
          } else {
            resolved = resolveParams(p, client.getMappings());
          }
          const result = await client.listIssues(
            resolved as Parameters<typeof client.listIssues>[0]
          );
          return jsonResult({
            ids: result.issues.map((i: { id: number }) => i.id),
            total_count: result.total_count,
          });
        } catch (error) {
          return errorResult(RedmineClient.formatError(error));
        }
      },
    },
    {
      tool: getIssueFullTool,
      handler: async (params) => {
        try {
          const { issue_id, include = [] } = params as { issue_id: number; include?: string[] };
          const result = await client.showIssue(issue_id, { include });
          return jsonResult(result);
        } catch (error) {
          return errorResult(RedmineClient.formatError(error));
        }
      },
    },
    {
      tool: searchIssueIdsTool,
      handler: async (params) => {
        try {
          const { query, project_id, limit } = params as {
            query: string;
            project_id?: string;
            limit?: number;
          };
          const result = await client.searchIssues(query, { project_id, limit });
          return jsonResult({
            ids: result.results.map((i: { id: number }) => i.id),
            total_count: result.total_count,
          });
        } catch (error) {
          return errorResult(RedmineClient.formatError(error));
        }
      },
    },
    {
      tool: createIssueTool,
      handler: async (params) => {
        try {
          const resolved = resolveParams(params as Record<string, unknown>, client.getMappings());
          if (resolved.assigned_to && !resolved.assigned_to_id) {
            const userId = await client.resolveUser(resolved.assigned_to as string);
            if (userId) resolved.assigned_to_id = userId;
            delete resolved.assigned_to;
          }
          if (resolved.parent_id !== undefined && resolved.parent_issue_id === undefined) {
            resolved.parent_issue_id = resolved.parent_id;
            delete resolved.parent_id;
          }
          const result = await client.createIssue(
            resolved as Parameters<typeof client.createIssue>[0]
          );
          return jsonResult(result);
        } catch (error) {
          return errorResult(RedmineClient.formatError(error));
        }
      },
    },
    {
      tool: updateIssueTool,
      handler: async (params) => {
        try {
          const resolved = resolveParams(params as Record<string, unknown>, client.getMappings());
          if (resolved.assigned_to && !resolved.assigned_to_id) {
            const userId = await client.resolveUser(resolved.assigned_to as string);
            if (userId) resolved.assigned_to_id = userId;
            delete resolved.assigned_to;
          }
          const { issue_id } = resolved as { issue_id: number };
          const updatedIssue = await client.updateIssue(
            issue_id,
            resolved as Parameters<typeof client.updateIssue>[1]
          );
          return jsonResult({
            id: updatedIssue.id,
            subject: updatedIssue.subject,
            status: updatedIssue.status,
          });
        } catch (error) {
          return errorResult(RedmineClient.formatError(error));
        }
      },
    },
    {
      tool: commentIssueTool,
      handler: async (params) => {
        try {
          const { issue_id, notes } = params as { issue_id: number; notes: string };
          await client.commentIssue(issue_id, notes);
          return jsonResult({ ok: true });
        } catch (error) {
          return errorResult(RedmineClient.formatError(error));
        }
      },
    },
  ];
}
