/**
 * Issue Tools - 7 tools for GitLab issue operations
 */

import {
  Tool,
  ToolDefinition,
  jsonResult,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  META_KEYS,
} from '@speedwave/mcp-shared';
import { GitLabClient } from '../client.js';
import { withValidation } from './validation.js';
import { TOOL_NAMES } from '../tool-names.js';
import { IDENTITY_SCOPES } from '../identity-scopes.js';

/** Documented fields of the raw GitLab issue object that listIssues and getIssue pass through. */
const ISSUE_PROPERTIES = {
  id: { type: 'number' },
  iid: { type: 'number' },
  title: { type: 'string' },
  description: { type: 'string' },
  state: { type: 'string' },
  labels: { type: 'array' },
  assignees: { type: 'array' },
  web_url: { type: 'string' },
};

const listIssuesTool: Tool = {
  name: 'listIssues',
  description:
    'List project issues. For "issues assigned to me", pass scope: "assigned_to_me" (or assignee_username for a specific user).',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: true,
    [META_KEYS.USER_SCOPED]: true,
    [META_KEYS.CURRENT_USER_TOOL]: TOOL_NAMES.GET_CURRENT_USER,
    [META_KEYS.SELF_PARAM]: "scope: 'assigned_to_me' | 'created_by_me'",
  },
  keywords: ['gitlab', 'issues', 'list', 'bugs', 'tasks'],
  example:
    'const { issues, count } = await gitlab.listIssues({ project_id: "speedwave/core", state: "opened" })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      state: { type: 'string', enum: ['opened', 'closed', 'all'], description: 'Issue state' },
      labels: { type: 'string', description: 'Comma-separated labels' },
      assignee_username: { type: 'string', description: 'Filter by assignee' },
      scope: {
        type: 'string',
        enum: [...IDENTITY_SCOPES],
        description:
          "Filter by identity relative to the authenticated user. Use with getCurrentUser to resolve 'me' without needing a username.",
      },
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
        items: { type: 'object', properties: ISSUE_PROPERTIES },
      },
      count: { type: 'number' },
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
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['gitlab', 'issue', 'get', 'show', 'details'],
  example: 'const issue = await gitlab.getIssue({ project_id: "speedwave/core", issue_iid: 42 })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      issue_iid: {
        type: ['number', 'string'],
        description: 'Issue IID as a number or string, e.g. 42 or "#42"',
      },
    },
    required: ['project_id', 'issue_iid'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      issue: { type: 'object', properties: ISSUE_PROPERTIES },
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
  _meta: { [META_KEYS.DEFER_LOADING]: true },
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
  description:
    'Update an issue: title, description, labels (replaces the set), state, or assignees (replaces the set).',
  annotations: WRITE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: true,
    [META_KEYS.USER_SCOPED]: true,
    [META_KEYS.CURRENT_USER_TOOL]: TOOL_NAMES.GET_CURRENT_USER,
  },
  keywords: ['gitlab', 'issue', 'update', 'edit', 'modify', 'assign', 'assignee'],
  example:
    'await gitlab.updateIssue({ project_id: "speedwave/core", issue_iid: 42, title: "Updated title", state_event: "close" })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      issue_iid: {
        type: ['number', 'string'],
        description: 'Issue IID as a number or string, e.g. 42 or "#42"',
      },
      title: { type: 'string', description: 'New title' },
      description: { type: 'string', description: 'New description' },
      labels: { type: 'string', description: 'Comma-separated labels' },
      state_event: { type: 'string', enum: ['close', 'reopen'], description: 'State event' },
      assignee_ids: {
        type: 'array',
        items: { type: 'number' },
        description: `Replacement assignee user IDs (an empty array unassigns). Does NOT accept 'me': resolve your own id via ${TOOL_NAMES.GET_CURRENT_USER} first.`,
      },
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
    {
      description: 'Assign issue to a user by id',
      input: {
        project_id: 'my-group/my-project',
        issue_iid: 123,
        assignee_ids: [7],
      },
    },
  ],
};

const closeIssueTool: Tool = {
  name: 'closeIssue',
  description: 'Close an issue',
  annotations: WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['gitlab', 'issue', 'close', 'resolve', 'done'],
  example: 'await gitlab.closeIssue({ project_id: "speedwave/core", issue_iid: 42 })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      issue_iid: {
        type: ['number', 'string'],
        description: 'Issue IID as a number or string, e.g. 42 or "#42"',
      },
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

const listIssueNotesTool: Tool = {
  name: 'listIssueNotes',
  description: 'List notes/comments on an issue',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['gitlab', 'issue', 'notes', 'comments'],
  example:
    'const notes = await gitlab.listIssueNotes({ project_id: "speedwave/core", issue_iid: 42 })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      issue_iid: {
        type: ['number', 'string'],
        description: 'Issue IID as a number or string, e.g. 42 or "#42"',
      },
      limit: { type: 'number', description: 'Max results (default 20)' },
    },
    required: ['project_id', 'issue_iid'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      notes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            body: { type: 'string' },
            author: { type: 'object' },
            created_at: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'List issue notes',
      input: { project_id: 'my-group/my-project', issue_iid: 123 },
    },
  ],
};

const createIssueNoteTool: Tool = {
  name: 'createIssueNote',
  description:
    'Add a comment/note to an issue. Posted as the currently authenticated GitLab user (the configured token owner).',
  annotations: WRITE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: true,
    [META_KEYS.USER_SCOPED]: true,
    [META_KEYS.CURRENT_USER_TOOL]: TOOL_NAMES.GET_CURRENT_USER,
  },
  keywords: ['gitlab', 'issue', 'comment', 'note'],
  example:
    'await gitlab.createIssueNote({ project_id: "speedwave/core", issue_iid: 42, body: "On it!" })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      issue_iid: {
        type: ['number', 'string'],
        description: 'Issue IID as a number or string, e.g. 42 or "#42"',
      },
      body: { type: 'string', description: 'Comment body' },
    },
    required: ['project_id', 'issue_iid', 'body'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      note: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          body: { type: 'string' },
          author: { type: 'object' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Add comment to issue',
      input: {
        project_id: 'my-group/my-project',
        issue_iid: 123,
        body: 'Looks good!',
      },
    },
  ],
};

/**
 * Tool handler function
 * @param client - GitLab client instance
 */
export function createIssueTools(client: GitLabClient | null): ToolDefinition[] {
  return [
    {
      tool: listIssuesTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, ...options } = params as {
          project_id: string | number;
          state?: string;
          labels?: string;
          assignee_username?: string;
          scope?: 'assigned_to_me' | 'created_by_me' | 'all';
          limit?: number;
        };
        const result = await c.listIssues(project_id, options);
        return jsonResult({ issues: result, count: result.length });
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
          assignee_ids?: number[];
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
    {
      tool: listIssueNotesTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, issue_iid, limit } = params as {
          project_id: string | number;
          issue_iid: number;
          limit?: number;
        };
        const result = await c.listIssueNotes(project_id, issue_iid, limit);
        return jsonResult(result);
      }),
    },
    {
      tool: createIssueNoteTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, issue_iid, body } = params as {
          project_id: string | number;
          issue_iid: number;
          body: string;
        };
        const result = await c.createIssueNote(project_id, issue_iid, body);
        return jsonResult(result);
      }),
    },
  ];
}
