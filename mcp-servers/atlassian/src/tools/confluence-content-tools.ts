/**
 * Confluence page-content tools — addPageComment, getPageComments,
 * addPageLabels, getPageLabels, listAttachments. 5 tools.
 * @module mcp-atlassian/tools/confluence-content-tools
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
import { createConfluenceContentClient } from '../domains/confluence-content.js';
import { toStorageBodyInput, withValidation } from './validation.js';

const addPageCommentTool: Tool = {
  name: 'addPageComment',
  description:
    'Add a footer comment to a Confluence page. Provide `bodyStorage` (storage XHTML) or `bodyText` (plain text). Restricted to the configured Confluence space allowlist, if any.',
  annotations: WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['confluence', 'comment', 'add', 'page', 'reply', 'note'],
  example:
    'await atlassian.addPageComment({ pageId: "12345", bodyText: "Reviewed — looks good." })',
  inputSchema: {
    type: 'object',
    properties: {
      pageId: { type: 'string', description: 'Confluence page ID' },
      bodyStorage: {
        type: 'string',
        description: 'Comment body in storage representation (XHTML)',
      },
      bodyText: { type: 'string', description: 'Plain-text comment body (wrapped in a <p>)' },
    },
    required: ['pageId'],
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
    { description: 'Plain text', input: { pageId: '12345', bodyText: 'Nice writeup.' } },
    {
      description: 'Storage body',
      input: { pageId: '12345', bodyStorage: '<p>See <strong>section 2</strong>.</p>' },
    },
  ],
};

const getPageCommentsTool: Tool = {
  name: 'getPageComments',
  description:
    'List footer comments on a Confluence page. Restricted to the configured Confluence space allowlist, if any.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['confluence', 'comments', 'list', 'page'],
  example: 'const { comments } = await atlassian.getPageComments({ pageId: "12345" })',
  inputSchema: {
    type: 'object',
    properties: {
      pageId: { type: 'string', description: 'Confluence page ID' },
      limit: { type: 'number', description: 'Max comments (default 25, max 100)' },
    },
    required: ['pageId'],
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
  inputExamples: [{ description: 'List comments', input: { pageId: '12345' } }],
};

const addPageLabelsTool: Tool = {
  name: 'addPageLabels',
  description:
    'Add one or more labels to a Confluence page. Restricted to the configured Confluence space allowlist, if any.',
  annotations: WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['confluence', 'labels', 'tags', 'add', 'page'],
  example:
    'const { labels } = await atlassian.addPageLabels({ pageId: "12345", labels: ["runbook", "ops"] })',
  inputSchema: {
    type: 'object',
    properties: {
      pageId: { type: 'string', description: 'Confluence page ID' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Label names to add' },
    },
    required: ['pageId', 'labels'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      labels: { type: 'array' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    { description: 'Add labels', input: { pageId: '12345', labels: ['docs', 'reviewed'] } },
  ],
};

const getPageLabelsTool: Tool = {
  name: 'getPageLabels',
  description:
    'List labels on a Confluence page. Restricted to the configured Confluence space allowlist, if any.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['confluence', 'labels', 'tags', 'list', 'page'],
  example: 'const { labels } = await atlassian.getPageLabels({ pageId: "12345" })',
  inputSchema: {
    type: 'object',
    properties: {
      pageId: { type: 'string', description: 'Confluence page ID' },
      limit: { type: 'number', description: 'Max labels (default 50, max 100)' },
    },
    required: ['pageId'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      labels: { type: 'array' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [{ description: 'List labels', input: { pageId: '12345' } }],
};

const listAttachmentsTool: Tool = {
  name: 'listAttachments',
  description:
    'List attachments on a Confluence page (metadata only — no download). Restricted to the configured Confluence space allowlist, if any.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['confluence', 'attachments', 'files', 'list', 'page'],
  example: 'const { attachments } = await atlassian.listAttachments({ pageId: "12345" })',
  inputSchema: {
    type: 'object',
    properties: {
      pageId: { type: 'string', description: 'Confluence page ID' },
      limit: { type: 'number', description: 'Max attachments (default 50, max 100)' },
    },
    required: ['pageId'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      attachments: { type: 'array' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [{ description: 'List attachments', input: { pageId: '12345' } }],
};

/**
 * Build the Confluence page-content tool definitions.
 * @param client - The Atlassian client (`null` when not configured).
 * @returns Tool definitions for page comments/labels/attachments.
 */
export function createConfluenceContentTools(client: AtlassianClient | null): ToolDefinition[] {
  const tools = [
    addPageCommentTool,
    getPageCommentsTool,
    addPageLabelsTool,
    getPageLabelsTool,
    listAttachmentsTool,
  ];
  if (!client) {
    const unconfigured = async () => errorResult(notConfiguredMessage('Atlassian'));
    return tools.map((tool) => ({ tool, handler: unconfigured }));
  }
  const content = createConfluenceContentClient(client);

  return [
    {
      tool: addPageCommentTool,
      handler: withValidation(client, async (_c, params) => {
        const p = params as { pageId: string; bodyStorage?: string; bodyText?: string };
        return jsonResult({ comment: await content.addComment(p.pageId, toStorageBodyInput(p)) });
      }),
    },
    {
      tool: getPageCommentsTool,
      handler: withValidation(client, async (_c, params) => {
        const { pageId, limit } = params as { pageId: string; limit?: number };
        return jsonResult({ comments: await content.getComments(pageId, { limit }) });
      }),
    },
    {
      tool: addPageLabelsTool,
      handler: withValidation(client, async (_c, params) => {
        const { pageId, labels } = params as { pageId: string; labels: string[] };
        return jsonResult({ labels: await content.addLabels(pageId, labels) });
      }),
    },
    {
      tool: getPageLabelsTool,
      handler: withValidation(client, async (_c, params) => {
        const { pageId, limit } = params as { pageId: string; limit?: number };
        return jsonResult({ labels: await content.getLabels(pageId, { limit }) });
      }),
    },
    {
      tool: listAttachmentsTool,
      handler: withValidation(client, async (_c, params) => {
        const { pageId, limit } = params as { pageId: string; limit?: number };
        return jsonResult({ attachments: await content.listAttachments(pageId, { limit }) });
      }),
    },
  ];
}
