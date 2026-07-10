/**
 * Jira issue tools — search (enhanced JQL), get/create/update, transitions,
 * assignment, and the current account. 8 tools.
 * @module mcp-atlassian/tools/jira-issue-tools
 */

import {
  type Tool,
  type ToolDefinition,
  jsonResult,
  errorResult,
  notConfiguredMessage,
  META_KEYS,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
} from '@speedwave/mcp-shared';
import { AtlassianClient } from '../client.js';
import { createJiraIssuesClient } from '../domains/jira-issues.js';
import type { AdfDoc } from '../types.js';
import { withValidation } from './validation.js';

/** Shared account-ID resolution guidance (no user-search tool exists here). */
const ACCOUNT_ID_RESOLUTION_GUIDANCE =
  'Resolve your own account ID via getMyself; for someone else, reuse an assignee/reporter account_id already present in a prior getIssue/searchIssues result, or ask the user rather than guessing.';

const searchIssuesTool: Tool = {
  name: 'searchIssues',
  description:
    'Search Jira issues with JQL (enhanced search; paginated by nextPageToken). For "my"/"assigned to me" queries use `assignee = currentUser()` directly in the JQL — no need to resolve an account ID first. If a project allowlist is configured, matches outside it are silently removed from the returned issues, and next_page_token/is_last still reflect the unfiltered upstream page (so a page that looks "last" may still be hiding excluded items).',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.USER_SCOPED]: true,
    [META_KEYS.CURRENT_USER_TOOL]: 'getMyself',
  },
  keywords: ['jira', 'issues', 'search', 'jql', 'query', 'tickets', 'find'],
  example:
    'const { issues, next_page_token } = await atlassian.searchIssues({ jql: "project = PROJ AND status = \\"To Do\\" ORDER BY created DESC", maxResults: 20 })',
  inputSchema: {
    type: 'object',
    properties: {
      jql: { type: 'string', description: 'JQL query string' },
      maxResults: { type: 'number', description: 'Max issues per page (default 50, max 100)' },
      nextPageToken: { type: 'string', description: 'Opaque cursor from a previous page' },
    },
    required: ['jql'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      issues: { type: 'array' },
      next_page_token: { type: ['string', 'null'] },
      is_last: { type: 'boolean' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    { description: 'Minimal: most recent issues', input: { jql: 'ORDER BY created DESC' } },
    {
      description: 'Partial: open issues in a project',
      input: { jql: 'project = PROJ AND statusCategory != Done' },
    },
    {
      description: 'Full: paginated search',
      input: { jql: 'assignee = currentUser()', maxResults: 25, nextPageToken: 'CAEaAggD' },
    },
  ],
};

const getIssueTool: Tool = {
  name: 'getIssue',
  description: 'Get a single Jira issue by key or ID.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: false },
  keywords: ['jira', 'issue', 'get', 'show', 'ticket', 'detail'],
  example: 'const issue = await atlassian.getIssue({ issueIdOrKey: "PROJ-123" })',
  inputSchema: {
    type: 'object',
    properties: {
      issueIdOrKey: { type: 'string', description: 'Issue key (e.g. PROJ-123) or numeric ID' },
    },
    required: ['issueIdOrKey'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      issue: { type: 'object' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    { description: 'By key', input: { issueIdOrKey: 'PROJ-123' } },
    { description: 'By numeric ID', input: { issueIdOrKey: '10042' } },
  ],
};

const createIssueTool: Tool = {
  name: 'createIssue',
  description:
    'Create a Jira issue. `bodyText` (plain text) becomes the description as ADF; pass `bodyAdf` for a pre-built ADF document.',
  annotations: WRITE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: true,
    [META_KEYS.USER_SCOPED]: true,
    [META_KEYS.CURRENT_USER_TOOL]: 'getMyself',
  },
  keywords: ['jira', 'issue', 'create', 'new', 'ticket', 'open'],
  example:
    'const issue = await atlassian.createIssue({ projectKey: "PROJ", summary: "Fix login", issueType: "Bug", bodyText: "Steps to reproduce..." })',
  inputSchema: {
    type: 'object',
    properties: {
      projectKey: { type: 'string', description: 'Target project key' },
      summary: { type: 'string', description: 'Issue summary' },
      issueType: { type: 'string', description: 'Issue type name (e.g. Task, Bug, Story)' },
      bodyText: { type: 'string', description: 'Plain-text description (converted to ADF)' },
      bodyAdf: {
        type: 'object',
        description: 'Pre-built Atlassian Document Format document (overrides bodyText)',
      },
      priority: { type: 'string', description: 'Priority name (e.g. High)' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Labels to apply' },
      assigneeAccountId: {
        type: 'string',
        description: `Cloud account ID to assign to (e.g. 5b10ac8d82e05b22cc7d4ef5), not a username or email. ${ACCOUNT_ID_RESOLUTION_GUIDANCE}`,
      },
    },
    required: ['projectKey', 'summary', 'issueType'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      issue: { type: 'object' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal',
      input: { projectKey: 'PROJ', summary: 'Task title', issueType: 'Task' },
    },
    {
      description: 'Partial: with description and labels',
      input: {
        projectKey: 'PROJ',
        summary: 'Bug',
        issueType: 'Bug',
        bodyText: 'Repro:\n1. ...',
        labels: ['triage'],
      },
    },
    {
      description: 'Full',
      input: {
        projectKey: 'PROJ',
        summary: 'Story',
        issueType: 'Story',
        bodyText: 'As a user...',
        priority: 'High',
        labels: ['frontend'],
        assigneeAccountId: '5b10a...',
      },
    },
  ],
};

const updateIssueTool: Tool = {
  name: 'updateIssue',
  description:
    'Update fields of a Jira issue (only provided fields change). `bodyText`/`bodyAdf` set the description.',
  annotations: WRITE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: true,
    [META_KEYS.USER_SCOPED]: true,
    [META_KEYS.CURRENT_USER_TOOL]: 'getMyself',
  },
  keywords: ['jira', 'issue', 'update', 'edit', 'change', 'modify', 'ticket'],
  example:
    'await atlassian.updateIssue({ issueIdOrKey: "PROJ-123", summary: "New title", priority: "Low" })',
  inputSchema: {
    type: 'object',
    properties: {
      issueIdOrKey: {
        type: 'string',
        description: 'Issue key or ID (an allowlist requires a key, not a numeric ID)',
      },
      summary: { type: 'string', description: 'New summary' },
      bodyText: { type: 'string', description: 'New plain-text description (converted to ADF)' },
      bodyAdf: { type: 'object', description: 'New ADF description (overrides bodyText)' },
      priority: { type: 'string', description: 'New priority name' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Replacement label set' },
      assigneeAccountId: {
        type: 'string',
        description: `Cloud account ID to reassign to (e.g. 5b10ac8d82e05b22cc7d4ef5), not a username or email. ${ACCOUNT_ID_RESOLUTION_GUIDANCE}`,
      },
    },
    required: ['issueIdOrKey'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      issue: { type: 'object' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    { description: 'Rename', input: { issueIdOrKey: 'PROJ-123', summary: 'Renamed' } },
    {
      description: 'Replace description',
      input: { issueIdOrKey: 'PROJ-123', bodyText: 'Updated details.' },
    },
    {
      description: 'Full',
      input: {
        issueIdOrKey: 'PROJ-123',
        summary: 'X',
        bodyText: 'Y',
        priority: 'High',
        labels: ['a', 'b'],
        assigneeAccountId: '5b10a...',
      },
    },
  ],
};

const getTransitionsTool: Tool = {
  name: 'getTransitions',
  description: 'List the workflow transitions currently available for an issue.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['jira', 'transitions', 'workflow', 'status', 'list'],
  example: 'const { transitions } = await atlassian.getTransitions({ issueIdOrKey: "PROJ-123" })',
  inputSchema: {
    type: 'object',
    properties: { issueIdOrKey: { type: 'string', description: 'Issue key or ID' } },
    required: ['issueIdOrKey'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      transitions: { type: 'array' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [{ description: 'List transitions', input: { issueIdOrKey: 'PROJ-123' } }],
};

const transitionIssueTool: Tool = {
  name: 'transitionIssue',
  description: 'Move an issue through a workflow transition by transition ID (see getTransitions).',
  annotations: WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['jira', 'transition', 'workflow', 'status', 'move', 'close', 'resolve'],
  example: 'await atlassian.transitionIssue({ issueIdOrKey: "PROJ-123", transitionId: "31" })',
  inputSchema: {
    type: 'object',
    properties: {
      issueIdOrKey: { type: 'string', description: 'Issue key or ID' },
      transitionId: { type: 'string', description: 'Transition ID from getTransitions' },
    },
    required: ['issueIdOrKey', 'transitionId'],
  },
  outputSchema: {
    type: 'object',
    properties: { success: { type: 'boolean' }, error: { type: 'string' } },
    required: ['success'],
  },
  inputExamples: [
    { description: 'Apply a transition', input: { issueIdOrKey: 'PROJ-123', transitionId: '31' } },
  ],
};

const assignIssueTool: Tool = {
  name: 'assignIssue',
  description: `Assign an issue to an account, or unassign it (omit accountId or pass null). ${ACCOUNT_ID_RESOLUTION_GUIDANCE}`,
  annotations: WRITE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: true,
    [META_KEYS.USER_SCOPED]: true,
    [META_KEYS.CURRENT_USER_TOOL]: 'getMyself',
  },
  keywords: ['jira', 'assign', 'assignee', 'unassign', 'owner'],
  example: 'await atlassian.assignIssue({ issueIdOrKey: "PROJ-123", accountId: "5b10a..." })',
  inputSchema: {
    type: 'object',
    properties: {
      issueIdOrKey: { type: 'string', description: 'Issue key or ID' },
      accountId: {
        type: ['string', 'null'],
        description:
          'Cloud account ID to assign to (e.g. 5b10ac8d82e05b22cc7d4ef5), or null/omit to unassign — not a username or email.',
      },
    },
    required: ['issueIdOrKey'],
  },
  outputSchema: {
    type: 'object',
    properties: { success: { type: 'boolean' }, error: { type: 'string' } },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Assign',
      input: { issueIdOrKey: 'PROJ-123', accountId: '5b10ac8d82e05b22cc7d4ef5' },
    },
    { description: 'Unassign', input: { issueIdOrKey: 'PROJ-123' } },
  ],
};

const getMyselfTool: Tool = {
  name: 'getMyself',
  description: 'Get the Atlassian account this worker authenticates as.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['jira', 'me', 'myself', 'current user', 'account', 'whoami'],
  example: 'const me = await atlassian.getMyself()',
  inputSchema: { type: 'object', properties: {} },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      user: { type: 'object' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [{ description: 'Who am I', input: {} }],
};

/**
 * Build the Jira issue tool definitions.
 * @param client - The Atlassian client (`null` when the service is not configured).
 * @returns Tool definitions for issue search/CRUD/transitions/assignment.
 */
export function createJiraIssueTools(client: AtlassianClient | null): ToolDefinition[] {
  const tools = [
    searchIssuesTool,
    getIssueTool,
    createIssueTool,
    updateIssueTool,
    getTransitionsTool,
    transitionIssueTool,
    assignIssueTool,
    getMyselfTool,
  ];
  if (!client) {
    const unconfigured = async () => errorResult(notConfiguredMessage('Atlassian'));
    return tools.map((tool) => ({ tool, handler: unconfigured }));
  }
  const issues = createJiraIssuesClient(client);

  return [
    {
      tool: searchIssuesTool,
      handler: withValidation(client, async (_c, params) => {
        const { jql, maxResults, nextPageToken } = params as {
          jql: string;
          maxResults?: number;
          nextPageToken?: string;
        };
        return jsonResult(await issues.search({ jql, maxResults, nextPageToken }));
      }),
    },
    {
      tool: getIssueTool,
      handler: withValidation(client, async (_c, params) => {
        const { issueIdOrKey } = params as { issueIdOrKey: string };
        return jsonResult({ issue: await issues.get(issueIdOrKey) });
      }),
    },
    {
      tool: createIssueTool,
      handler: withValidation(client, async (_c, params) => {
        const p = params as {
          projectKey: string;
          summary: string;
          issueType: string;
          bodyText?: string;
          bodyAdf?: AdfDoc;
          priority?: string;
          labels?: string[];
          assigneeAccountId?: string;
        };
        const body = p.bodyAdf ?? p.bodyText;
        return jsonResult({
          issue: await issues.create({
            projectKey: p.projectKey,
            summary: p.summary,
            issueType: p.issueType,
            body,
            priority: p.priority,
            labels: p.labels,
            assigneeAccountId: p.assigneeAccountId,
          }),
        });
      }),
    },
    {
      tool: updateIssueTool,
      handler: withValidation(client, async (_c, params) => {
        const p = params as {
          issueIdOrKey: string;
          summary?: string;
          bodyText?: string;
          bodyAdf?: AdfDoc;
          priority?: string;
          labels?: string[];
          assigneeAccountId?: string;
        };
        const body = p.bodyAdf ?? p.bodyText;
        return jsonResult({
          issue: await issues.update(p.issueIdOrKey, {
            summary: p.summary,
            body,
            priority: p.priority,
            labels: p.labels,
            assigneeAccountId: p.assigneeAccountId,
          }),
        });
      }),
    },
    {
      tool: getTransitionsTool,
      handler: withValidation(client, async (_c, params) => {
        const { issueIdOrKey } = params as { issueIdOrKey: string };
        return jsonResult({ transitions: await issues.getTransitions(issueIdOrKey) });
      }),
    },
    {
      tool: transitionIssueTool,
      handler: withValidation(client, async (_c, params) => {
        const { issueIdOrKey, transitionId } = params as {
          issueIdOrKey: string;
          transitionId: string;
        };
        await issues.transition(issueIdOrKey, transitionId);
        return jsonResult({ transitioned: true });
      }),
    },
    {
      tool: assignIssueTool,
      handler: withValidation(client, async (_c, params) => {
        const { issueIdOrKey, accountId } = params as {
          issueIdOrKey: string;
          accountId?: string | null;
        };
        await issues.assign(issueIdOrKey, accountId ?? null);
        return jsonResult({ assigned: true });
      }),
    },
    {
      tool: getMyselfTool,
      handler: withValidation(client, async () => jsonResult({ user: await issues.getMyself() })),
    },
  ];
}
