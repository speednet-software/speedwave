/**
 * Confluence page tools — searchPages (CQL), getPage, getPageByTitle,
 * createPage, updatePage, getPageChildren. 6 tools.
 * @module mcp-atlassian/tools/confluence-page-tools
 */

import {
  type Tool,
  type ToolDefinition,
  jsonResult,
  errorResult,
  notConfiguredMessage,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
} from '@speedwave/mcp-shared';
import { AtlassianClient } from '../client.js';
import { createConfluencePagesClient } from '../domains/confluence-pages.js';
import { toStorageBodyInput, withValidation } from './validation.js';

const searchPagesTool: Tool = {
  name: 'searchPages',
  description: 'Search Confluence content with CQL (Confluence Query Language). Returns pages.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: false },
  keywords: ['confluence', 'pages', 'search', 'cql', 'query', 'wiki', 'find'],
  example:
    'const { pages } = await atlassian.searchPages({ cql: "space = DEV AND type = page AND text ~ \\"runbook\\"", limit: 10 })',
  inputSchema: {
    type: 'object',
    properties: {
      cql: { type: 'string', description: 'CQL query string' },
      limit: { type: 'number', description: 'Max results (default 25, max 100)' },
    },
    required: ['cql'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      pages: { type: 'array' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    { description: 'Recent pages', input: { cql: 'type = page ORDER BY created DESC' } },
    { description: 'In a space', input: { cql: 'space = DEV AND type = page' } },
    {
      description: 'Full-text in a space',
      input: { cql: 'space = DEV AND text ~ "deployment"', limit: 5 },
    },
  ],
};

const getPageTool: Tool = {
  name: 'getPage',
  description: 'Get a Confluence page by ID (optionally including the storage-format body).',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: false },
  keywords: ['confluence', 'page', 'get', 'show', 'read', 'wiki'],
  example: 'const page = await atlassian.getPage({ pageId: "12345", includeBody: true })',
  inputSchema: {
    type: 'object',
    properties: {
      pageId: { type: 'string', description: 'Confluence page ID' },
      includeBody: {
        type: 'boolean',
        description: 'Include the storage-representation body (default false)',
      },
    },
    required: ['pageId'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      page: { type: 'object' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    { description: 'Metadata only', input: { pageId: '12345' } },
    { description: 'With body', input: { pageId: '12345', includeBody: true } },
  ],
};

const getPageByTitleTool: Tool = {
  name: 'getPageByTitle',
  description: 'Find a Confluence page by exact title within a space.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['confluence', 'page', 'title', 'find', 'lookup'],
  example: 'const page = await atlassian.getPageByTitle({ spaceKey: "DEV", title: "Onboarding" })',
  inputSchema: {
    type: 'object',
    properties: {
      spaceKey: { type: 'string', description: 'Space key' },
      title: { type: 'string', description: 'Exact page title' },
      includeBody: {
        type: 'boolean',
        description: 'Include the storage-representation body (default false)',
      },
    },
    required: ['spaceKey', 'title'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      page: { type: 'object' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    { description: 'By title', input: { spaceKey: 'DEV', title: 'Runbook' } },
    { description: 'With body', input: { spaceKey: 'DEV', title: 'Runbook', includeBody: true } },
  ],
};

const createPageTool: Tool = {
  name: 'createPage',
  description:
    'Create a Confluence page in a space. Provide `bodyStorage` (storage XHTML) or `bodyText` (plain text, wrapped in a paragraph).',
  annotations: WRITE_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['confluence', 'page', 'create', 'new', 'wiki', 'write'],
  example:
    'const page = await atlassian.createPage({ spaceKey: "DEV", title: "Release Notes 1.2", bodyText: "Highlights:\\n- ...", parentId: "100" })',
  inputSchema: {
    type: 'object',
    properties: {
      spaceKey: { type: 'string', description: 'Target space key' },
      title: { type: 'string', description: 'Page title' },
      bodyStorage: {
        type: 'string',
        description: 'Body in Confluence storage representation (XHTML)',
      },
      bodyText: { type: 'string', description: 'Plain-text body (wrapped in a <p>)' },
      parentId: { type: 'string', description: 'Parent page ID (optional)' },
    },
    required: ['spaceKey', 'title'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      page: { type: 'object' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal (plain text)',
      input: { spaceKey: 'DEV', title: 'Notes', bodyText: 'Hello' },
    },
    {
      description: 'Storage body under a parent',
      input: { spaceKey: 'DEV', title: 'Child', bodyStorage: '<h1>Hi</h1>', parentId: '100' },
    },
  ],
};

const updatePageTool: Tool = {
  name: 'updatePage',
  description:
    'Update a Confluence page (the current version is fetched and incremented automatically). Provide `bodyStorage` or `bodyText` to replace the body.',
  annotations: WRITE_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['confluence', 'page', 'update', 'edit', 'change', 'wiki', 'write'],
  example:
    'await atlassian.updatePage({ pageId: "12345", title: "New Title", bodyText: "Updated content." })',
  inputSchema: {
    type: 'object',
    properties: {
      pageId: { type: 'string', description: 'Confluence page ID' },
      title: { type: 'string', description: 'New title (kept as-is if omitted)' },
      bodyStorage: { type: 'string', description: 'New body in storage representation (XHTML)' },
      bodyText: { type: 'string', description: 'New plain-text body (wrapped in a <p>)' },
    },
    required: ['pageId'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      page: { type: 'object' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    { description: 'Replace body', input: { pageId: '12345', bodyText: 'Refreshed.' } },
    {
      description: 'Rename + body',
      input: { pageId: '12345', title: 'V2', bodyStorage: '<p>v2</p>' },
    },
  ],
};

const getPageChildrenTool: Tool = {
  name: 'getPageChildren',
  description: 'List the direct child pages of a Confluence page.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['confluence', 'page', 'children', 'tree', 'list', 'subpages'],
  example: 'const { pages } = await atlassian.getPageChildren({ pageId: "12345" })',
  inputSchema: {
    type: 'object',
    properties: {
      pageId: { type: 'string', description: 'Parent page ID' },
      limit: { type: 'number', description: 'Max children (default 25, max 100)' },
    },
    required: ['pageId'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      pages: { type: 'array' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [{ description: 'Direct children', input: { pageId: '12345' } }],
};

/**
 * Build the Confluence page tool definitions.
 * @param client - The Atlassian client (`null` when not configured).
 * @returns Tool definitions for Confluence pages.
 */
export function createConfluencePageTools(client: AtlassianClient | null): ToolDefinition[] {
  const tools = [
    searchPagesTool,
    getPageTool,
    getPageByTitleTool,
    createPageTool,
    updatePageTool,
    getPageChildrenTool,
  ];
  if (!client) {
    const unconfigured = async () => errorResult(notConfiguredMessage('Atlassian'));
    return tools.map((tool) => ({ tool, handler: unconfigured }));
  }
  const pages = createConfluencePagesClient(client);

  return [
    {
      tool: searchPagesTool,
      handler: withValidation(client, async (_c, params) => {
        const { cql, limit } = params as { cql: string; limit?: number };
        return jsonResult({ pages: await pages.search({ cql, limit }) });
      }),
    },
    {
      tool: getPageTool,
      handler: withValidation(client, async (_c, params) => {
        const { pageId, includeBody } = params as { pageId: string; includeBody?: boolean };
        return jsonResult({ page: await pages.get(pageId, { includeBody }) });
      }),
    },
    {
      tool: getPageByTitleTool,
      handler: withValidation(client, async (_c, params) => {
        const { spaceKey, title, includeBody } = params as {
          spaceKey: string;
          title: string;
          includeBody?: boolean;
        };
        return jsonResult({ page: await pages.getByTitle(spaceKey, title, { includeBody }) });
      }),
    },
    {
      tool: createPageTool,
      handler: withValidation(client, async (_c, params) => {
        const p = params as {
          spaceKey: string;
          title: string;
          bodyStorage?: string;
          bodyText?: string;
          parentId?: string;
        };
        return jsonResult({
          page: await pages.create({
            spaceKey: p.spaceKey,
            title: p.title,
            body: toStorageBodyInput(p),
            parentId: p.parentId,
          }),
        });
      }),
    },
    {
      tool: updatePageTool,
      handler: withValidation(client, async (_c, params) => {
        const p = params as {
          pageId: string;
          title?: string;
          bodyStorage?: string;
          bodyText?: string;
        };
        const hasBody = p.bodyStorage !== undefined || p.bodyText !== undefined;
        return jsonResult({
          page: await pages.update(p.pageId, {
            title: p.title,
            body: hasBody ? toStorageBodyInput(p) : undefined,
          }),
        });
      }),
    },
    {
      tool: getPageChildrenTool,
      handler: withValidation(client, async (_c, params) => {
        const { pageId, limit } = params as { pageId: string; limit?: number };
        return jsonResult({ pages: await pages.getChildren(pageId, { limit }) });
      }),
    },
  ];
}
