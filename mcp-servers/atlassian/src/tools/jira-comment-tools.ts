/**
 * Jira comment and worklog tools: addComment, getComments, addWorklog. 3 tools.
 * @module mcp-atlassian/tools/jira-comment-tools
 */

import {
  type Tool,
  type ToolDefinition,
  jsonResult,
  errorResult,
  teachingErrorResult,
  withDeclaredParams,
  notConfiguredMessage,
  META_KEYS,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
} from '@speedwave/mcp-shared';
import { AtlassianClient } from '../client.js';
import { createJiraCommentsClient } from '../domains/jira-comments.js';
import { isAdfDoc } from '../adf.js';
import type { AdfDoc } from '../types.js';
import { withValidation } from './validation.js';

const addCommentTool: Tool = {
  name: 'addComment',
  description:
    'Add a comment to a Jira issue. `body` is Markdown (headings, lists, code, tables, links, `[@Name](mention:<accountId>)` mentions). Pass `body_adf` instead for content Markdown cannot express; give exactly one of them.',
  annotations: WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['jira', 'comment', 'add', 'reply', 'note', 'issue'],
  example: 'await atlassian.addComment({ issue: "PROJ-123", body: "Looking into this." })',
  inputSchema: {
    type: 'object',
    properties: {
      issue: { type: 'string', description: 'Issue key or ID' },
      body: { type: 'string', description: 'Comment body in Markdown' },
      body_adf: {
        type: 'object',
        description:
          'Pre-built ADF document, for content Markdown cannot express (instead of body)',
      },
    },
    required: ['issue'],
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
    { description: 'Markdown', input: { issue: 'PROJ-123', body: 'Done.' } },
    {
      description: 'Multi-line',
      input: { issue: 'PROJ-123', body: 'Update:\n- fixed A\n- pending B' },
    },
    {
      description: 'Raw ADF',
      input: { issue: 'PROJ-123', body_adf: { version: 1, type: 'doc', content: [] } },
    },
  ],
};

const getCommentsTool: Tool = {
  name: 'getComments',
  description:
    'List comments on a Jira issue. Bodies are Markdown; ADF nodes with no Markdown equivalent appear as [adf:<type>] markers.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['jira', 'comments', 'list', 'issue', 'discussion'],
  example: 'const { comments } = await atlassian.getComments({ issue: "PROJ-123" })',
  inputSchema: {
    type: 'object',
    properties: {
      issue: { type: 'string', description: 'Issue key or ID' },
      max_results: { type: 'number', description: 'Max comments (default 50, max 100)' },
    },
    required: ['issue'],
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
    { description: 'List comments', input: { issue: 'PROJ-123' } },
    { description: 'Limit results', input: { issue: 'PROJ-123', max_results: 10 } },
  ],
};

const addWorklogTool: Tool = {
  name: 'addWorklog',
  description:
    'Log work against a Jira issue (time in seconds; optional Markdown comment and start time). Pass `comment_adf` instead of `comment` for content Markdown cannot express. Speedwave authenticates as one shared Atlassian account per project, not a per-human login: every worklog is attributed to that account, so "my hours" always means it.',
  annotations: WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['jira', 'worklog', 'time', 'log work', 'timesheet', 'effort'],
  example:
    'await atlassian.addWorklog({ issue: "PROJ-123", time_spent_seconds: 3600, comment: "Pairing on the fix" })',
  inputSchema: {
    type: 'object',
    properties: {
      issue: { type: 'string', description: 'Issue key or ID' },
      time_spent_seconds: { type: 'number', description: 'Seconds of work logged' },
      comment: { type: 'string', description: 'Worklog comment in Markdown' },
      comment_adf: {
        type: 'object',
        description: 'Pre-built ADF worklog comment (instead of comment)',
      },
      started: { type: 'string', description: 'ISO 8601 start timestamp (defaults to now)' },
    },
    required: ['issue', 'time_spent_seconds'],
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
    { description: 'Minimal', input: { issue: 'PROJ-123', time_spent_seconds: 1800 } },
    {
      description: 'With comment',
      input: { issue: 'PROJ-123', time_spent_seconds: 3600, comment: 'Investigation' },
    },
    {
      description: 'Full',
      input: {
        issue: 'PROJ-123',
        time_spent_seconds: 5400,
        comment: 'Implementation',
        started: '2026-05-11T09:00:00.000+0000',
      },
    },
  ],
};

/**
 * Build the Jira comment/worklog tool definitions.
 * @param client - The Atlassian client (`null` when not configured).
 */
export function createJiraCommentTools(client: AtlassianClient | null): ToolDefinition[] {
  const tools = [addCommentTool, getCommentsTool, addWorklogTool];
  if (!client) {
    const unconfigured = async () => errorResult(notConfiguredMessage('Atlassian'));
    return tools.map((tool) => ({ tool, handler: withDeclaredParams(tool, unconfigured) }));
  }
  const comments = createJiraCommentsClient(client);

  const definitions: ToolDefinition[] = [
    {
      tool: addCommentTool,
      handler: withValidation(client, async (_c, params) => {
        const p = params as { issue: string; body?: string; body_adf?: unknown };
        const body = requireRichText('body', p.body, 'body_adf', p.body_adf);
        if ('error' in body) return body.error;
        return jsonResult({ comment: await comments.add(p.issue, body.value) });
      }),
    },
    {
      tool: getCommentsTool,
      handler: withValidation(client, async (_c, params) => {
        const { issue, max_results } = params as { issue: string; max_results?: number };
        return jsonResult({ comments: await comments.list(issue, { maxResults: max_results }) });
      }),
    },
    {
      tool: addWorklogTool,
      handler: withValidation(client, async (_c, params) => {
        const p = params as {
          issue: string;
          time_spent_seconds: number;
          comment?: string;
          comment_adf?: unknown;
          started?: string;
        };
        const comment = resolveRichText('comment', p.comment, 'comment_adf', p.comment_adf);
        if ('error' in comment) return comment.error;
        return jsonResult({
          worklog: await comments.addWorklog(p.issue, {
            timeSpentSeconds: p.time_spent_seconds,
            comment: comment.value,
            started: p.started,
          }),
        });
      }),
    },
  ];
  return definitions.map(({ tool, handler }) => ({
    tool,
    handler: withDeclaredParams(tool, handler),
  }));
}

type RichTextResult<T> = { value: T } | { error: ReturnType<typeof teachingErrorResult> };

function requireRichText(
  markdownName: string,
  markdown: string | undefined,
  adfName: string,
  adf: unknown
): RichTextResult<string | AdfDoc> {
  const resolved = resolveRichText(markdownName, markdown, adfName, adf);
  if ('error' in resolved) return resolved;
  if (resolved.value === undefined) {
    return {
      error: teachingErrorResult({
        paramName: `${markdownName} or ${adfName}`,
        nextStep: `Give ${markdownName} (Markdown) or ${adfName} (ADF). Nothing was sent.`,
      }),
    };
  }
  return { value: resolved.value };
}

function resolveRichText(
  markdownName: string,
  markdown: string | undefined,
  adfName: string,
  adf: unknown
): RichTextResult<string | AdfDoc | undefined> {
  if (markdown !== undefined && adf !== undefined) {
    return {
      error: teachingErrorResult({
        paramName: `${markdownName} and ${adfName}`,
        nextStep: `Give ${markdownName} (Markdown) or ${adfName} (ADF), not both. Nothing was sent.`,
      }),
    };
  }
  if (adf === undefined) return { value: markdown };
  if (!isAdfDoc(adf)) {
    return {
      error: teachingErrorResult({
        paramName: adfName,
        received: adf,
        nextStep: `${adfName} must be an ADF document: { version: 1, type: "doc", content: [...] }. Nothing was sent.`,
      }),
    };
  }
  return { value: adf };
}
