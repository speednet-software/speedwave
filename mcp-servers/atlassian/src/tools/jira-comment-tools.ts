/**
 * Jira comment & worklog tools — addComment, getComments, addWorklog. 3 tools.
 * @module mcp-atlassian/tools/jira-comment-tools
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
import { createJiraCommentsClient } from '../domains/jira-comments.js';
import type { AdfDoc } from '../types.js';
import { withValidation } from './validation.js';

const addCommentTool: Tool = {
  name: 'addComment',
  description:
    'Add a comment to a Jira issue. `bodyText` is plain text (converted to ADF); pass `bodyAdf` for a pre-built ADF document.',
  annotations: WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['jira', 'comment', 'add', 'reply', 'note', 'issue'],
  example:
    'await atlassian.addComment({ issueIdOrKey: "PROJ-123", bodyText: "Looking into this." })',
  inputSchema: {
    type: 'object',
    properties: {
      issueIdOrKey: { type: 'string', description: 'Issue key or ID' },
      bodyText: { type: 'string', description: 'Plain-text comment body (converted to ADF)' },
      bodyAdf: { type: 'object', description: 'Pre-built ADF document (overrides bodyText)' },
    },
    required: ['issueIdOrKey'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      comment: { type: 'object' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    { description: 'Plain text', input: { issueIdOrKey: 'PROJ-123', bodyText: 'Done.' } },
    {
      description: 'Multi-line',
      input: { issueIdOrKey: 'PROJ-123', bodyText: 'Update:\n- fixed A\n- pending B' },
    },
    {
      description: 'Raw ADF',
      input: { issueIdOrKey: 'PROJ-123', bodyAdf: { version: 1, type: 'doc', content: [] } },
    },
  ],
};

const getCommentsTool: Tool = {
  name: 'getComments',
  description: 'List comments on a Jira issue.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['jira', 'comments', 'list', 'issue', 'discussion'],
  example: 'const { comments } = await atlassian.getComments({ issueIdOrKey: "PROJ-123" })',
  inputSchema: {
    type: 'object',
    properties: {
      issueIdOrKey: { type: 'string', description: 'Issue key or ID' },
      maxResults: { type: 'number', description: 'Max comments (default 50, max 100)' },
    },
    required: ['issueIdOrKey'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      comments: { type: 'array' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    { description: 'List comments', input: { issueIdOrKey: 'PROJ-123' } },
    { description: 'Limit results', input: { issueIdOrKey: 'PROJ-123', maxResults: 10 } },
  ],
};

const addWorklogTool: Tool = {
  name: 'addWorklog',
  description:
    'Log work against a Jira issue (time in seconds; optional comment and start time). Speedwave authenticates as one shared Atlassian account per project, not a per-human login — every worklog is attributed to that account, so "my hours" always means it.',
  annotations: WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['jira', 'worklog', 'time', 'log work', 'timesheet', 'effort'],
  example:
    'await atlassian.addWorklog({ issueIdOrKey: "PROJ-123", timeSpentSeconds: 3600, comment: "Pairing on the fix" })',
  inputSchema: {
    type: 'object',
    properties: {
      issueIdOrKey: { type: 'string', description: 'Issue key or ID' },
      timeSpentSeconds: { type: 'number', description: 'Seconds of work logged' },
      comment: { type: 'string', description: 'Plain-text worklog comment (converted to ADF)' },
      commentAdf: {
        type: 'object',
        description: 'Pre-built ADF worklog comment (overrides comment)',
      },
      started: { type: 'string', description: 'ISO 8601 start timestamp (defaults to now)' },
    },
    required: ['issueIdOrKey', 'timeSpentSeconds'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      worklog: { type: 'object' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    { description: 'Minimal', input: { issueIdOrKey: 'PROJ-123', timeSpentSeconds: 1800 } },
    {
      description: 'With comment',
      input: { issueIdOrKey: 'PROJ-123', timeSpentSeconds: 3600, comment: 'Investigation' },
    },
    {
      description: 'Full',
      input: {
        issueIdOrKey: 'PROJ-123',
        timeSpentSeconds: 5400,
        comment: 'Implementation',
        started: '2026-05-11T09:00:00.000+0000',
      },
    },
  ],
};

/**
 * Build the Jira comment/worklog tool definitions.
 * @param client - The Atlassian client (`null` when not configured).
 * @returns Tool definitions for comments and worklog.
 */
export function createJiraCommentTools(client: AtlassianClient | null): ToolDefinition[] {
  const tools = [addCommentTool, getCommentsTool, addWorklogTool];
  if (!client) {
    const unconfigured = async () => errorResult(notConfiguredMessage('Atlassian'));
    return tools.map((tool) => ({ tool, handler: unconfigured }));
  }
  const comments = createJiraCommentsClient(client);

  return [
    {
      tool: addCommentTool,
      handler: withValidation(client, async (_c, params) => {
        const p = params as { issueIdOrKey: string; bodyText?: string; bodyAdf?: AdfDoc };
        const body = p.bodyAdf ?? p.bodyText ?? '';
        return jsonResult({ comment: await comments.add(p.issueIdOrKey, body) });
      }),
    },
    {
      tool: getCommentsTool,
      handler: withValidation(client, async (_c, params) => {
        const { issueIdOrKey, maxResults } = params as {
          issueIdOrKey: string;
          maxResults?: number;
        };
        return jsonResult({ comments: await comments.list(issueIdOrKey, { maxResults }) });
      }),
    },
    {
      tool: addWorklogTool,
      handler: withValidation(client, async (_c, params) => {
        const p = params as {
          issueIdOrKey: string;
          timeSpentSeconds: number;
          comment?: string;
          commentAdf?: AdfDoc;
          started?: string;
        };
        return jsonResult({
          worklog: await comments.addWorklog(p.issueIdOrKey, {
            timeSpentSeconds: p.timeSpentSeconds,
            comment: p.commentAdf ?? p.comment,
            started: p.started,
          }),
        });
      }),
    },
  ];
}
