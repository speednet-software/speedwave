/**
 * Issue Tools - 6 tools for Redmine issue operations
 */

import { Tool, ToolDefinition, jsonResult, errorResult } from '@speedwave/mcp-shared';
import { RedmineClient } from '../client.js';
import { resolveParams } from './helpers.js';

// Tool Definitions
const listIssueIdsTool: Tool = {
  name: 'listIssueIds',
  description: 'List issue IDs with optional filters. Returns only IDs for efficiency.',
  category: 'read',
  keywords: ['redmine', 'issues', 'list', 'filter', 'tasks', 'bugs', 'ids'],
  example: `const { ids, total_count } = await redmine.listIssueIds({ status: "open", assigned_to: "me" })`,
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
            subject: { type: 'string' },
            status: {
              type: 'object',
              properties: { id: { type: 'number' }, name: { type: 'string' } },
            },
            priority: {
              type: 'object',
              properties: { id: { type: 'number' }, name: { type: 'string' } },
            },
            tracker: {
              type: 'object',
              properties: { id: { type: 'number' }, name: { type: 'string' } },
            },
            assigned_to: {
              type: 'object',
              properties: { id: { type: 'number' }, name: { type: 'string' } },
            },
            project: {
              type: 'object',
              properties: { id: { type: 'number' }, name: { type: 'string' } },
            },
          },
        },
      },
      total_count: { type: 'number' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: list all issues (with defaults)',
      input: {},
    },
    {
      description: 'Partial: my open issues',
      input: { status: 'open', assigned_to: 'me' },
    },
    {
      description: 'Full: project issues with subtasks',
      input: { project_id: 'my-project', status: 'open', assigned_to: 'me', limit: 50 },
    },
  ],
};

const getIssueFullTool: Tool = {
  name: 'getIssueFull',
  description: 'Get complete issue data including custom_fields, relations. No truncation.',
  category: 'read',
  keywords: ['redmine', 'issue', 'show', 'get', 'detail', 'single', 'full'],
  example: `const issue = await redmine.getIssueFull({ issue_id: 12345, include: ["journals", "attachments"] })`,
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
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      issue: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          subject: { type: 'string' },
          description: { type: 'string' },
          status: {
            type: 'object',
            properties: { id: { type: 'number' }, name: { type: 'string' } },
          },
          priority: {
            type: 'object',
            properties: { id: { type: 'number' }, name: { type: 'string' } },
          },
          tracker: {
            type: 'object',
            properties: { id: { type: 'number' }, name: { type: 'string' } },
          },
          assigned_to: {
            type: 'object',
            properties: { id: { type: 'number' }, name: { type: 'string' } },
          },
          project: {
            type: 'object',
            properties: { id: { type: 'number' }, name: { type: 'string' } },
          },
          created_on: { type: 'string', description: 'ISO 8601 timestamp' },
          updated_on: { type: 'string', description: 'ISO 8601 timestamp' },
          journals: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'number' },
                user: {
                  type: 'object',
                  properties: { id: { type: 'number' }, name: { type: 'string' } },
                },
                notes: { type: 'string' },
                created_on: { type: 'string' },
              },
            },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: get basic issue details',
      input: { issue_id: 12345 },
    },
    {
      description: 'Full: get issue with journals, attachments and relations',
      input: { issue_id: 12345, include: ['journals', 'attachments', 'relations'] },
    },
  ],
};

const searchIssueIdsTool: Tool = {
  name: 'searchIssueIds',
  description: 'Search issues by text query. Returns matching IDs only.',
  category: 'read',
  keywords: ['redmine', 'issue', 'search', 'find', 'query', 'ids'],
  example: `const { ids, total_count } = await redmine.searchIssueIds({ query: "authentication error", project_id: "my-project" })`,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      project_id: { type: 'string', description: 'Limit to project' },
      limit: { type: 'number', description: 'Max results (default 25)' },
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
};

const createIssueTool: Tool = {
  name: 'createIssue',
  description: 'Create a new Redmine issue',
  category: 'write',
  keywords: ['redmine', 'issue', 'create', 'new', 'task', 'bug', 'add'],
  example: `const issue = await redmine.createIssue({ subject: "Fix bug", project_id: "my-project", tracker: "bug" })`,
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
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      issue: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'ID of created issue' },
          subject: { type: 'string' },
          project: {
            type: 'object',
            properties: { id: { type: 'number' }, name: { type: 'string' } },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: create with required fields only',
      input: { subject: 'Fix login bug', project_id: 'my-project' },
    },
    {
      description: 'Partial: bug with priority',
      input: {
        subject: 'Users cannot reset password',
        project_id: 'my-project',
        tracker: 'bug',
        priority: 'high',
        assigned_to: 'me',
      },
    },
    {
      description: 'Full: create subtask with all fields',
      input: {
        subject: 'Implement JWT validation',
        project_id: 'my-project',
        description:
          'h2. Context\n\nToken expiry not validated.\n\nh2. Acceptance Criteria\n\n* Validate token on each request',
        tracker: 'task',
        priority: 'normal',
        assigned_to: 'jane.doe',
        parent_issue_id: 12345,
      },
    },
  ],
};

const updateIssueTool: Tool = {
  name: 'updateIssue',
  description: 'Update an existing Redmine issue',
  category: 'write',
  keywords: ['redmine', 'issue', 'update', 'modify', 'change', 'edit', 'move', 'project'],
  example: `const updated = await redmine.updateIssue({ issue_id: 12345, assigned_to_id: userId });
// IMPORTANT: Verify change was applied - Redmine silently ignores some changes for closed issues
if (!updated.assigned_to || updated.assigned_to.id !== userId) {
  throw new Error("Assignment failed - issue status may block this change");
}`,
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
  outputSchema: {
    type: 'object',
    description:
      'Returns the updated issue - ALWAYS verify assigned_to/status match your request (Redmine may silently ignore changes for closed issues)',
    properties: {
      id: { type: 'number', description: 'Issue ID' },
      subject: { type: 'string', description: 'Issue subject' },
      status: {
        type: 'object',
        properties: { id: { type: 'number' }, name: { type: 'string' } },
      },
      assigned_to: {
        type: 'object',
        description: 'Assigned user (null if Redmine rejected assignment)',
        properties: { id: { type: 'number' }, name: { type: 'string' } },
      },
      project: {
        type: 'object',
        properties: { id: { type: 'number' }, name: { type: 'string' } },
      },
    },
  },
  inputExamples: [
    {
      description: 'Minimal: close issue',
      input: { issue_id: 12345, status: 'closed' },
    },
    {
      description: 'Partial: reassign with note',
      input: {
        issue_id: 12345,
        assigned_to_id: 42,
        notes: 'Reassigning for code review',
      },
    },
    {
      description: 'Full: update multiple fields',
      input: {
        issue_id: 12345,
        subject: 'Updated title',
        status: 'in_progress',
        assigned_to_id: 42,
        notes: 'Starting work on this issue',
      },
    },
  ],
};

const commentIssueTool: Tool = {
  name: 'commentIssue',
  description: 'Add a comment to an issue',
  category: 'write',
  keywords: ['redmine', 'issue', 'comment', 'note', 'add'],
  example: `await redmine.commentIssue({ issue_id: 12345, notes: "Work in progress" })`,
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'number', description: 'Issue ID' },
      notes: { type: 'string', description: 'Comment text' },
    },
    required: ['issue_id', 'notes'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      journal_id: { type: 'number', description: 'ID of created journal entry' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Simple comment',
      input: { issue_id: 12345, notes: 'Work in progress' },
    },
    {
      description: 'Detailed comment with Textile',
      input: {
        issue_id: 12345,
        notes: 'h3. Update\n\n* Completed code review\n* Tests passing\n* Ready for merge',
      },
    },
  ],
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
