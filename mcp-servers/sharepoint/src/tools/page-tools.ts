/**
 * Page Tools — CRUD for SharePoint Pages (`microsoft.graph.sitePage`).
 *
 * 8 tools (PR4):
 *   listPages, getPage, createPage, updatePage,
 *   addWebPart, updateWebPart, removeWebPart, publishPage
 *
 * ADR-060 / PR3 site-policy invariant — by omission:
 *   None of these tools accepts `site_id` from the model. Every Graph call
 *   uses the cached `siteId` from `/tokens/site_id` (read at worker init).
 *
 * Scope requirement: `Sites.Manage.All` is requested at consent time (PR3).
 * `createPage` formally needs `Sites.ReadWrite.All`, a subset of Sites.Manage.All.
 *
 * Supported web part types: `text`, `image`, `link`. Other types out of scope.
 */

import {
  Tool,
  ToolDefinition,
  notConfiguredMessage,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
} from '@speedwave/mcp-shared';
import { withValidation, validateGraphId, ToolResult } from './validation.js';
import { SharePointClient } from '../client.js';
import { PagesClient, PAGE_RESOURCE } from '../graph/pages-client.js';

/**
 * A web part on a SharePoint page — projection of the Graph `webPart` resource.
 * Currently only `textWebPart` is exposed via the write tools (PR4 MVP).
 * `standardWebPart` (image, link, etc.) requires Graph-specific GUID-typed
 * payloads with a large web-part-type catalog and is deferred — see
 * https://learn.microsoft.com/en-us/graph/api/resources/standardwebpart.
 */
export interface WebPart {
  id: string;
  /** Graph `@odata.type` discriminator (e.g. `#microsoft.graph.textWebPart`). */
  '@odata.type'?: string;
  /** Body text for text web parts. */
  innerHtml?: string;
}

/** A column inside a canvas section (Graph `horizontalSectionColumn`). */
export interface CanvasColumn {
  id: string;
  width?: number;
  webparts?: WebPart[];
}

/** A horizontal section on the page (Graph `horizontalSection`). */
export interface CanvasSection {
  id: string;
  emphasis?: string;
  columns?: CanvasColumn[];
}

/** The canvas layout container expanded on `getPage`. */
export interface CanvasLayout {
  horizontalSections?: CanvasSection[];
}

/** Narrowed `microsoft.graph.sitePage` projection used by the tools. */
export interface SitePage {
  id: string;
  name?: string;
  title?: string;
  webUrl?: string;
  canvasLayout?: CanvasLayout;
}

//═══════════════════════════════════════════════════════════════════════════════
// Tool schemas
//═══════════════════════════════════════════════════════════════════════════════

const listPagesTool: Tool = {
  name: 'listPages',
  description: 'List all pages in the configured SharePoint site.',
  // No site_id — the worker uses its stored site (ADR-060 site policy).
  inputSchema: { type: 'object', properties: {} },
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: false },
  keywords: ['sharepoint', 'pages', 'list'],
  example: 'const result = await sharepoint.listPages()',
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      pages: { type: 'array', items: { type: 'object' } },
    },
    required: ['success'],
  },
};

const getPageTool: Tool = {
  name: 'getPage',
  description: 'Get a page including its canvas layout.',
  inputSchema: {
    type: 'object',
    properties: { pageId: { type: 'string' } },
    required: ['pageId'],
  },
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: false },
  keywords: ['sharepoint', 'pages', 'get'],
  example: 'const page = await sharepoint.getPage({ pageId: "abc-123" })',
  outputSchema: {
    type: 'object',
    properties: { success: { type: 'boolean' }, page: { type: 'object' } },
    required: ['success'],
  },
};

const createPageTool: Tool = {
  name: 'createPage',
  description: 'Create a new SharePoint page (requires Sites.ReadWrite.All).',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      name: { type: 'string', description: 'Filename suffix' },
      canvasLayout: { type: 'object', description: 'Optional initial layout' },
    },
    required: ['title', 'name'],
  },
  annotations: WRITE_ANNOTATIONS,
  _meta: { deferLoading: false },
  keywords: ['sharepoint', 'pages', 'create'],
  example: 'const page = await sharepoint.createPage({ title: "Hi", name: "hi.aspx" })',
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      pageId: { type: 'string' },
      webUrl: { type: 'string' },
    },
    required: ['success'],
  },
};

const updatePageTool: Tool = {
  name: 'updatePage',
  description:
    'Replace the canvas layout of a page (Graph requires the FULL layout — partial PATCH not supported).',
  inputSchema: {
    type: 'object',
    properties: {
      pageId: { type: 'string' },
      canvasLayout: { type: 'object', description: 'Complete layout (replaces existing)' },
    },
    required: ['pageId', 'canvasLayout'],
  },
  annotations: WRITE_ANNOTATIONS,
  _meta: { deferLoading: false },
  keywords: ['sharepoint', 'pages', 'update', 'edit', 'layout'],
  example: 'await sharepoint.updatePage({ pageId: "abc", canvasLayout: {...} })',
  outputSchema: {
    type: 'object',
    properties: { success: { type: 'boolean' } },
    required: ['success'],
  },
};

const addWebPartTool: Tool = {
  name: 'addWebPart',
  description:
    'Append a text web part to a section/column on a page. Section/column are addressed by 0-based index into the current layout. Image/link/other web part types are not yet supported (Graph standardWebPart requires per-type GUID payloads).',
  inputSchema: {
    type: 'object',
    properties: {
      pageId: { type: 'string' },
      // Capped to prevent OOM from a malicious/buggy caller passing a huge index.
      // SharePoint pages have a handful of sections in practice; 20/10 is generous.
      sectionIndex: { type: 'number', minimum: 0, maximum: 20 },
      columnIndex: { type: 'number', minimum: 0, maximum: 10 },
      innerHtml: {
        type: 'string',
        description: 'HTML body for the text web part (Graph `innerHtml` field)',
      },
    },
    required: ['pageId', 'sectionIndex', 'columnIndex', 'innerHtml'],
  },
  annotations: WRITE_ANNOTATIONS,
  _meta: { deferLoading: false },
  keywords: ['sharepoint', 'pages', 'webpart', 'add', 'text'],
  example:
    'await sharepoint.addWebPart({ pageId: "abc", sectionIndex: 0, columnIndex: 0, innerHtml: "<p>Hi</p>" })',
  outputSchema: {
    type: 'object',
    properties: { success: { type: 'boolean' }, webPartId: { type: 'string' } },
    required: ['success'],
  },
};

const updateWebPartTool: Tool = {
  name: 'updateWebPart',
  description:
    'Replace the body of a text web part identified by `webPartId`. Only text web parts are supported (matches addWebPart).',
  inputSchema: {
    type: 'object',
    properties: {
      pageId: { type: 'string' },
      webPartId: { type: 'string' },
      innerHtml: { type: 'string' },
    },
    required: ['pageId', 'webPartId', 'innerHtml'],
  },
  annotations: WRITE_ANNOTATIONS,
  _meta: { deferLoading: false },
  keywords: ['sharepoint', 'pages', 'webpart', 'update', 'edit', 'text'],
  example:
    'await sharepoint.updateWebPart({ pageId: "abc", webPartId: "wp1", innerHtml: "<p>...</p>" })',
  outputSchema: {
    type: 'object',
    properties: { success: { type: 'boolean' } },
    required: ['success'],
  },
};

const removeWebPartTool: Tool = {
  name: 'removeWebPart',
  description: 'Remove a web part from a page by id.',
  inputSchema: {
    type: 'object',
    properties: {
      pageId: { type: 'string' },
      webPartId: { type: 'string' },
    },
    required: ['pageId', 'webPartId'],
  },
  annotations: WRITE_ANNOTATIONS,
  _meta: { deferLoading: false },
  keywords: ['sharepoint', 'pages', 'webpart', 'remove', 'delete'],
  example: 'await sharepoint.removeWebPart({ pageId: "abc", webPartId: "wp1" })',
  outputSchema: {
    type: 'object',
    properties: { success: { type: 'boolean' } },
    required: ['success'],
  },
};

const publishPageTool: Tool = {
  name: 'publishPage',
  description: 'Publish a SharePoint page so it is visible to readers.',
  inputSchema: {
    type: 'object',
    properties: { pageId: { type: 'string' } },
    required: ['pageId'],
  },
  annotations: WRITE_ANNOTATIONS,
  _meta: { deferLoading: false },
  keywords: ['sharepoint', 'pages', 'publish'],
  example: 'await sharepoint.publishPage({ pageId: "abc-123" })',
  outputSchema: {
    type: 'object',
    properties: { success: { type: 'boolean' } },
    required: ['success'],
  },
};

//═══════════════════════════════════════════════════════════════════════════════
// Handlers
//═══════════════════════════════════════════════════════════════════════════════

function pages(client: SharePointClient): PagesClient {
  return new PagesClient(client);
}

function wrapErr(code: string, error: unknown): ToolResult {
  return {
    success: false,
    error: { code, message: SharePointClient.formatError(error) },
  };
}

/**
 * Handler for `listPages` — GET all pages in the configured site.
 * @param client - the SharePoint client
 */
async function handleListPages(client: SharePointClient): Promise<ToolResult> {
  try {
    const resp = (await pages(client).listPages()) as { value?: SitePage[] } | undefined;
    return {
      success: true,
      data: {
        pages: (resp?.value ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          title: p.title,
          webUrl: p.webUrl,
        })),
      },
    };
  } catch (e) {
    return wrapErr('LIST_PAGES_FAILED', e);
  }
}

/**
 * Handler for `getPage` — GET one page with expanded `canvasLayout`.
 * @param client - the SharePoint client
 * @param params - input parameters
 * @param params.pageId - SharePoint page id to fetch
 */
async function handleGetPage(
  client: SharePointClient,
  params: { pageId: string }
): Promise<ToolResult> {
  const idErr = validateGraphId(params.pageId, 'pageId');
  if (idErr) return idErr;
  try {
    const page = (await pages(client).getPage(params.pageId)) as SitePage | undefined;
    return { success: true, data: { page } };
  } catch (e) {
    return wrapErr('GET_PAGE_FAILED', e);
  }
}

/**
 * Handler for `createPage` — POST a new `microsoft.graph.sitePage`.
 * @param client - the SharePoint client
 * @param params - input parameters
 * @param params.title - display title
 * @param params.name - filename suffix (`.aspx` is appended by Graph)
 * @param params.canvasLayout - optional initial layout (omitted = empty page)
 */
async function handleCreatePage(
  client: SharePointClient,
  params: { title: string; name: string; canvasLayout?: CanvasLayout }
): Promise<ToolResult> {
  try {
    const body: Record<string, unknown> = {
      '@odata.type': `#${PAGE_RESOURCE}`,
      name: params.name,
      title: params.title,
    };
    if (params.canvasLayout) body.canvasLayout = params.canvasLayout;
    const created = (await pages(client).createPage(body)) as SitePage | undefined;
    return {
      success: true,
      data: { pageId: created?.id ?? '', webUrl: created?.webUrl ?? '' },
    };
  } catch (e) {
    return wrapErr('CREATE_PAGE_FAILED', e);
  }
}

/**
 * Handler for `updatePage` — PATCH the entire canvasLayout of an existing page.
 * Graph requires the FULL layout; partial patch is not supported.
 * @param client - the SharePoint client
 * @param params - input parameters
 * @param params.pageId - target page id
 * @param params.canvasLayout - the complete new layout
 */
async function handleUpdatePage(
  client: SharePointClient,
  params: { pageId: string; canvasLayout: CanvasLayout }
): Promise<ToolResult> {
  const idErr = validateGraphId(params.pageId, 'pageId');
  if (idErr) return idErr;
  try {
    await pages(client).updatePage(params.pageId, params.canvasLayout);
    return { success: true, data: {} };
  } catch (e) {
    return wrapErr('UPDATE_PAGE_FAILED', e);
  }
}

/**
 * Handler for `addWebPart` — POST a text web part to a specific column.
 *
 * Index-to-id resolution: SharePoint addresses sections/columns by GUID, not
 * by index. We GET the layout, walk by index, then POST to the dedicated
 * `.../horizontalSections/{section-id}/columns/{column-id}/webparts` endpoint.
 * @param client - the SharePoint client
 * @param params - input parameters
 * @param params.pageId - target page id
 * @param params.sectionIndex - 0-based horizontal section index in the current layout
 * @param params.columnIndex - 0-based column index within that section
 * @param params.innerHtml - HTML body for the text web part
 */
async function handleAddWebPart(
  client: SharePointClient,
  params: {
    pageId: string;
    sectionIndex: number;
    columnIndex: number;
    innerHtml: string;
  }
): Promise<ToolResult> {
  const idErr = validateGraphId(params.pageId, 'pageId');
  if (idErr) return idErr;
  // Defense in depth — schema enforces the same range but `withValidation`
  // does not run JSON Schema validation, so cap here too.
  const MAX_SECTION = 20;
  const MAX_COLUMN = 10;
  if (
    !Number.isInteger(params.sectionIndex) ||
    params.sectionIndex < 0 ||
    params.sectionIndex > MAX_SECTION
  ) {
    return {
      success: false,
      error: { code: 'INVALID_INDEX', message: `sectionIndex must be 0..${MAX_SECTION}` },
    };
  }
  if (
    !Number.isInteger(params.columnIndex) ||
    params.columnIndex < 0 ||
    params.columnIndex > MAX_COLUMN
  ) {
    return {
      success: false,
      error: { code: 'INVALID_INDEX', message: `columnIndex must be 0..${MAX_COLUMN}` },
    };
  }
  if (typeof params.innerHtml !== 'string') {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'innerHtml must be a string' },
    };
  }
  try {
    const pagesApi = pages(client);
    const page = (await pagesApi.getPage(params.pageId)) as SitePage | undefined;
    if (!page) {
      return { success: false, error: { code: 'NOT_FOUND', message: 'page not found' } };
    }
    const sections = page.canvasLayout?.horizontalSections ?? [];
    const section = sections[params.sectionIndex];
    if (!section) {
      return {
        success: false,
        error: {
          code: 'SECTION_OUT_OF_RANGE',
          message: `sectionIndex ${params.sectionIndex} not present (page has ${sections.length})`,
        },
      };
    }
    const columns = section.columns ?? [];
    const column = columns[params.columnIndex];
    if (!column) {
      return {
        success: false,
        error: {
          code: 'COLUMN_OUT_OF_RANGE',
          message: `columnIndex ${params.columnIndex} not present (section has ${columns.length})`,
        },
      };
    }
    // The Graph ids are URL path segments — defend against injection at the
    // boundary, even though Graph generated them.
    const sectErr = validateGraphId(section.id, 'section.id');
    if (sectErr) return sectErr;
    const colErr = validateGraphId(column.id, 'column.id');
    if (colErr) return colErr;

    const created = (await pagesApi.addTextWebPart(
      params.pageId,
      section.id,
      column.id,
      params.innerHtml
    )) as WebPart | undefined;
    return { success: true, data: { webPartId: created?.id ?? '' } };
  } catch (e) {
    return wrapErr('ADD_WEBPART_FAILED', e);
  }
}

/**
 * Handler for `updateWebPart` — PATCH a text web part directly by id.
 *
 * Graph supports per-web-part PATCH at `.../webparts/{webPartId}`; we don't
 * need to fetch + re-PATCH the whole layout.
 * @param client - the SharePoint client
 * @param params - input parameters
 * @param params.pageId - target page id
 * @param params.webPartId - Graph id of the web part to replace
 * @param params.innerHtml - new HTML body
 */
async function handleUpdateWebPart(
  client: SharePointClient,
  params: { pageId: string; webPartId: string; innerHtml: string }
): Promise<ToolResult> {
  const pidErr = validateGraphId(params.pageId, 'pageId');
  if (pidErr) return pidErr;
  const wpErr = validateGraphId(params.webPartId, 'webPartId');
  if (wpErr) return wpErr;
  if (typeof params.innerHtml !== 'string') {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'innerHtml must be a string' },
    };
  }
  try {
    await pages(client).updateTextWebPart(params.pageId, params.webPartId, params.innerHtml);
    return { success: true, data: {} };
  } catch (e) {
    return wrapErr('UPDATE_WEBPART_FAILED', e);
  }
}

/**
 * Handler for `removeWebPart` — DELETE a web part directly by id.
 *
 * Graph supports per-web-part DELETE at `.../webparts/{webPartId}`.
 * @param client - the SharePoint client
 * @param params - input parameters
 * @param params.pageId - target page id
 * @param params.webPartId - Graph id of the web part to remove
 */
async function handleRemoveWebPart(
  client: SharePointClient,
  params: { pageId: string; webPartId: string }
): Promise<ToolResult> {
  const pidErr = validateGraphId(params.pageId, 'pageId');
  if (pidErr) return pidErr;
  const wpErr = validateGraphId(params.webPartId, 'webPartId');
  if (wpErr) return wpErr;
  try {
    await pages(client).removeWebPart(params.pageId, params.webPartId);
    return { success: true, data: {} };
  } catch (e) {
    return wrapErr('REMOVE_WEBPART_FAILED', e);
  }
}

/**
 * Handler for `publishPage` — POST `/publish` to make a draft page visible.
 * @param client - the SharePoint client
 * @param params - input parameters
 * @param params.pageId - target page id
 */
async function handlePublishPage(
  client: SharePointClient,
  params: { pageId: string }
): Promise<ToolResult> {
  const idErr = validateGraphId(params.pageId, 'pageId');
  if (idErr) return idErr;
  try {
    await pages(client).publishPage(params.pageId);
    return { success: true, data: {} };
  } catch (e) {
    return wrapErr('PUBLISH_PAGE_FAILED', e);
  }
}

//═══════════════════════════════════════════════════════════════════════════════
// Factory
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Build the page tool definitions. When the client is null the tools return
 * a "not configured" error per the existing SharePoint convention.
 * @param client - the initialized SharePoint client (or null)
 */
export function createPageTools(client: SharePointClient | null): ToolDefinition[] {
  const withClient =
    <T>(handler: (c: SharePointClient, p: T) => Promise<ToolResult>) =>
    async (params: T): Promise<ToolResult> => {
      if (!client) {
        return {
          success: false,
          error: {
            code: 'NOT_CONFIGURED',
            message: notConfiguredMessage('SharePoint'),
          },
        };
      }
      return handler(client, params);
    };

  return [
    {
      tool: listPagesTool,
      handler: withValidation<Record<string, never>>(withClient((c) => handleListPages(c))),
    },
    {
      tool: getPageTool,
      handler: withValidation<{ pageId: string }>(withClient(handleGetPage)),
    },
    {
      tool: createPageTool,
      handler: withValidation<{
        title: string;
        name: string;
        canvasLayout?: CanvasLayout;
      }>(withClient(handleCreatePage)),
    },
    {
      tool: updatePageTool,
      handler: withValidation<{ pageId: string; canvasLayout: CanvasLayout }>(
        withClient(handleUpdatePage)
      ),
    },
    {
      tool: addWebPartTool,
      handler: withValidation<{
        pageId: string;
        sectionIndex: number;
        columnIndex: number;
        innerHtml: string;
      }>(withClient(handleAddWebPart)),
    },
    {
      tool: updateWebPartTool,
      handler: withValidation<{
        pageId: string;
        webPartId: string;
        innerHtml: string;
      }>(withClient(handleUpdateWebPart)),
    },
    {
      tool: removeWebPartTool,
      handler: withValidation<{ pageId: string; webPartId: string }>(
        withClient(handleRemoveWebPart)
      ),
    },
    {
      tool: publishPageTool,
      handler: withValidation<{ pageId: string }>(withClient(handlePublishPage)),
    },
  ];
}

// Export tool schemas for the regression test that asserts no site_id leak.
export const PAGE_TOOL_SCHEMAS = [
  listPagesTool,
  getPageTool,
  createPageTool,
  updatePageTool,
  addWebPartTool,
  updateWebPartTool,
  removeWebPartTool,
  publishPageTool,
];
