/**
 * Jira issue tools — search (enhanced JQL), get/create/update, transitions,
 * assignment, the current account, and attachment upload/delete. 10 tools.
 * @module mcp-atlassian/tools/jira-issue-tools
 */

import {
  type Tool,
  type ToolDefinition,
  jsonResult,
  errorResult,
  notConfiguredMessage,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  DESTRUCTIVE_ANNOTATIONS,
} from '@speedwave/mcp-shared';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { AtlassianClient } from '../client.js';
import { createJiraIssuesClient } from '../domains/jira-issues.js';
import type { AdfDoc } from '../types.js';
import { withValidation } from './validation.js';

/** Root of the read-only project mount inside the worker (overridable for tests). */
function workspaceRoot(): string {
  return process.env.WORKSPACE_DIR || '/workspace';
}
/** Cap for file-path attachments (bytes read from disk, not through the hub body). */
const MAX_FILE_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Read a file from the read-only workspace mount, rejecting any path that escapes
 * the workspace (traversal or symlink) so a tokened worker can't read `/tokens` etc.
 * @param filePath - Path relative to (or inside) the workspace root.
 * @returns The file bytes and its basename.
 */
async function readWorkspaceFile(filePath: string): Promise<{ buffer: Buffer; name: string }> {
  const root = await fsp.realpath(workspaceRoot());
  const candidate = path.resolve(root, filePath);
  let real: string;
  try {
    real = await fsp.realpath(candidate);
  } catch {
    throw new Error(`File not found under workspace: ${filePath}`);
  }
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new Error('filePath must resolve to a location inside the workspace');
  }
  const stat = await fsp.stat(real);
  if (!stat.isFile()) throw new Error(`Not a regular file: ${filePath}`);
  if (stat.size > MAX_FILE_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachment too large: ${stat.size} B exceeds the ${MAX_FILE_ATTACHMENT_BYTES} B limit.`
    );
  }
  return { buffer: await fsp.readFile(real), name: path.basename(real) };
}

const searchIssuesTool: Tool = {
  name: 'searchIssues',
  description: 'Search Jira issues with JQL (enhanced search; paginated by nextPageToken).',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: false },
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
  _meta: { deferLoading: false },
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
  _meta: { deferLoading: true },
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
      assigneeAccountId: { type: 'string', description: 'Account ID to assign to' },
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
  _meta: { deferLoading: true },
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
      },
    },
  ],
};

const getTransitionsTool: Tool = {
  name: 'getTransitions',
  description: 'List the workflow transitions currently available for an issue.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: true },
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
  _meta: { deferLoading: true },
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
  description: 'Assign an issue to an account, or unassign it (omit accountId or pass null).',
  annotations: WRITE_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['jira', 'assign', 'assignee', 'unassign', 'owner'],
  example: 'await atlassian.assignIssue({ issueIdOrKey: "PROJ-123", accountId: "5b10a..." })',
  inputSchema: {
    type: 'object',
    properties: {
      issueIdOrKey: { type: 'string', description: 'Issue key or ID' },
      accountId: {
        type: ['string', 'null'],
        description: 'Account ID to assign to (null/omit to unassign)',
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
  _meta: { deferLoading: true },
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

const addAttachmentTool: Tool = {
  name: 'addAttachment',
  description:
    "Attach a file to a Jira issue. The worker reads `filePath` (a path under /workspace) from disk and streams it — no size limit beyond Jira's.",
  annotations: WRITE_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['jira', 'attachment', 'attach', 'upload', 'file', 'screenshot', 'image', 'załącznik'],
  example:
    'await atlassian.addAttachment({ issueIdOrKey: "PROJ-123", filePath: "/workspace/bug.png" })',
  inputSchema: {
    type: 'object',
    properties: {
      issueIdOrKey: { type: 'string', description: 'Issue key (e.g. PROJ-123) or numeric ID' },
      filePath: {
        type: 'string',
        description: 'Path under /workspace to read and stream (e.g. /workspace/bug.png)',
      },
      filename: {
        type: 'string',
        description: 'Attachment file name; defaults to the basename of filePath',
      },
      contentType: { type: 'string', description: 'MIME type (default application/octet-stream)' },
    },
    required: ['issueIdOrKey', 'filePath'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      attachment: { type: 'object' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'From a workspace file',
      input: { issueIdOrKey: 'PROJ-123', filePath: '/workspace/bug.png' },
    },
    {
      description: 'With an explicit filename and MIME type',
      input: {
        issueIdOrKey: 'PROJ-123',
        filePath: '/workspace/.speedwave/shot.png',
        filename: 'bug.png',
        contentType: 'image/png',
      },
    },
  ],
};

const deleteAttachmentTool: Tool = {
  name: 'deleteAttachment',
  description: 'Delete a Jira attachment by its attachment ID (irreversible).',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['jira', 'attachment', 'delete', 'remove', 'załącznik', 'usuń'],
  example: 'await atlassian.deleteAttachment({ attachmentId: "10475" })',
  inputSchema: {
    type: 'object',
    properties: {
      attachmentId: { type: 'string', description: 'Attachment ID (e.g. 10475)' },
    },
    required: ['attachmentId'],
  },
  outputSchema: {
    type: 'object',
    properties: { success: { type: 'boolean' }, error: { type: 'string' } },
    required: ['success'],
  },
  inputExamples: [{ description: 'Delete an attachment', input: { attachmentId: '10475' } }],
};

/**
 * Build the Jira issue tool definitions.
 * @param client - The Atlassian client (`null` when the service is not configured).
 * @returns Tool definitions for issue search/CRUD/transitions/assignment/attachments.
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
    addAttachmentTool,
    deleteAttachmentTool,
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
        };
        const body = p.bodyAdf ?? p.bodyText;
        return jsonResult({
          issue: await issues.update(p.issueIdOrKey, {
            summary: p.summary,
            body,
            priority: p.priority,
            labels: p.labels,
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
    {
      tool: addAttachmentTool,
      handler: withValidation(client, async (_c, params) => {
        const { issueIdOrKey, filename, filePath, contentType } = params as {
          issueIdOrKey: string;
          filename?: string;
          filePath?: string;
          contentType?: string;
        };
        if (!issueIdOrKey) throw new Error('issueIdOrKey is required');
        if (!filePath) throw new Error('filePath is required (a path under /workspace)');

        // Worker reads the file directly from the read-only workspace mount and streams it.
        const file = await readWorkspaceFile(filePath);
        return jsonResult({
          attachment: await issues.addAttachment(issueIdOrKey, {
            filename: filename || file.name,
            data: file.buffer,
            contentType: contentType || 'application/octet-stream',
          }),
        });
      }),
    },
    {
      tool: deleteAttachmentTool,
      handler: withValidation(client, async (_c, params) => {
        const { attachmentId } = params as { attachmentId: string };
        if (!attachmentId) throw new Error('attachmentId is required');
        await issues.deleteAttachment(attachmentId);
        return jsonResult({ deleted: true });
      }),
    },
  ];
}
