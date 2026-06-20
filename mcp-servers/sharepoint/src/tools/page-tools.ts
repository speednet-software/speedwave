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
 * Web part types: text web parts (via `innerHtml`) plus the 14 standard
 * web parts Graph documents — see `STANDARD_WEBPART_TYPES` in pages-client.ts.
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
import {
  PagesClient,
  PAGE_RESOURCE,
  STANDARD_WEBPART_TYPES,
  buildImageWebPartData,
  extractHeadings,
  injectHeadingAnchors,
  renderTableOfContents,
} from '../graph/pages-client.js';

/**
 * A web part on a SharePoint page — projection of the Graph `webPart` resource.
 * Currently only `textWebPart` is exposed via the write tools (PR4 MVP).
 * `standardWebPart` (image, link, etc.) requires Graph-specific GUID-typed
 * payloads with a large web-part-type catalog and is deferred — see
 * https://learn.microsoft.com/en-us/graph/api/resources/standardwebpart.
 */
export interface WebPart {
  id: string;
  /** Graph `@odata.type` discriminator (e.g. `#microsoft.graph.textwebpart`). */
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
    'Update page metadata and/or canvas layout. At least one optional field must be supplied. Graph requires the FULL canvasLayout when present (partial PATCH not supported); other fields can be set independently.',
  inputSchema: {
    type: 'object',
    properties: {
      pageId: { type: 'string' },
      title: { type: 'string', description: 'Page title' },
      description: { type: 'string', description: 'Page description' },
      thumbnailWebUrl: { type: 'string', description: 'URL of the page thumbnail image' },
      showComments: { type: 'boolean', description: 'Show the comments section' },
      showRecommendedPages: {
        type: 'boolean',
        description: 'Show the recommended-pages section',
      },
      promotionKind: {
        type: 'string',
        enum: ['page', 'newsPost'],
        description: 'Promotion kind — set to "newsPost" to promote a page as news.',
      },
      titleArea: {
        type: 'object',
        description:
          'Title area (hero) configuration. Properties: imageWebUrl, layout ("imageAndTitle"|"plain"|"colorBlock"|"overlap"), textAlignment ("left"|"center"), enableGradientEffect, showAuthor, showPublishedDate, showTextBlockAboveTitle, textAboveTitle, alternativeText.',
        properties: {
          imageWebUrl: { type: 'string' },
          layout: { type: 'string' },
          textAlignment: { type: 'string' },
          enableGradientEffect: { type: 'boolean' },
          showAuthor: { type: 'boolean' },
          showPublishedDate: { type: 'boolean' },
          showTextBlockAboveTitle: { type: 'boolean' },
          textAboveTitle: { type: 'string' },
          alternativeText: { type: 'string' },
        },
      },
      canvasLayout: {
        type: 'object',
        description: 'Complete layout (replaces existing — Graph requires the full structure)',
      },
    },
    required: ['pageId'],
  },
  annotations: WRITE_ANNOTATIONS,
  _meta: { deferLoading: false },
  keywords: ['sharepoint', 'pages', 'update', 'edit', 'layout', 'title', 'hero', 'news', 'promote'],
  example:
    'await sharepoint.updatePage({ pageId: "abc", title: "New title", showComments: false })',
  outputSchema: {
    type: 'object',
    properties: { success: { type: 'boolean' } },
    required: ['success'],
  },
};

const addWebPartTool: Tool = {
  name: 'addWebPart',
  description:
    "Append a web part to a section/column on a page. Defaults to a text web part (supply `innerHtml`); pass `webPartType` to add one of Graph's 13 standard web parts (bingMaps, button, callToAction, divider, documentEmbed, image, imageGallery, linkPreview, orgChart, people, quickLinks, spacer, youtubeEmbed — note: `titleArea` is a sitePage property handled by `updatePage`, not a web part). Section/column are addressed by 0-based index. `data` is an optional webPartData payload (per-type shape — Graph docs do not publish them; consult SharePoint UI / SPFx docs).",
  inputSchema: {
    type: 'object',
    properties: {
      pageId: { type: 'string' },
      // Capped to bound index values from an untrusted caller.
      sectionIndex: { type: 'number', minimum: 0, maximum: 20 },
      columnIndex: { type: 'number', minimum: 0, maximum: 10 },
      innerHtml: {
        type: 'string',
        description: 'HTML body for a text web part (required when `webPartType` is omitted).',
      },
      webPartType: {
        type: 'string',
        // Derived from the SSOT `STANDARD_WEBPART_TYPES`.
        enum: Object.keys(STANDARD_WEBPART_TYPES),
        description:
          'Standard web part type. Mutually exclusive with `innerHtml` (which targets text web parts).',
      },
      data: {
        type: 'object',
        description:
          'Optional webPartData payload for standard web parts (audiences, dataVersion, description, properties, serverProcessedContent, title). Per-type properties shape is web-part-specific.',
      },
    },
    required: ['pageId', 'sectionIndex', 'columnIndex'],
  },
  annotations: WRITE_ANNOTATIONS,
  _meta: { deferLoading: false },
  keywords: [
    'sharepoint',
    'pages',
    'webpart',
    'add',
    'text',
    'image',
    'button',
    'divider',
    'quicklinks',
  ],
  example:
    'await sharepoint.addWebPart({ pageId: "abc", sectionIndex: 0, columnIndex: 0, webPartType: "image", data: { title: "Hero" } })',
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

const addImageWebPartTool: Tool = {
  name: 'addImageWebPart',
  description:
    "Insert an image web part pinned to a file already in this site's drive (Site Assets / Documents). Speedwave looks up the file's `sharepointIds` and `image` facet so the payload survives the SharePoint UI's image-picker reconciliation on Save & Close — external URLs that aren't backed by a driveItem are dropped. Use `sharepoint.uploadFile` first to push the source into the drive, then pass its relative path here.",
  inputSchema: {
    type: 'object',
    properties: {
      pageId: { type: 'string' },
      sectionIndex: { type: 'number', minimum: 0, maximum: 20 },
      columnIndex: { type: 'number', minimum: 0, maximum: 10 },
      sharepointPath: {
        type: 'string',
        description:
          "Path relative to the site's drive root (e.g. `Shared Documents/hero.jpg`). The file MUST already exist — call `uploadFile` first.",
      },
      altText: { type: 'string' },
      captionText: { type: 'string' },
      overlayText: { type: 'string' },
      alignment: { type: 'string', enum: ['Left', 'Center', 'Right'] },
      fixAspectRatio: { type: 'boolean' },
    },
    required: ['pageId', 'sectionIndex', 'columnIndex', 'sharepointPath'],
  },
  annotations: WRITE_ANNOTATIONS,
  _meta: { deferLoading: false },
  keywords: ['sharepoint', 'pages', 'webpart', 'image', 'add'],
  example:
    'await sharepoint.addImageWebPart({ pageId: "abc", sectionIndex: 1, columnIndex: 0, sharepointPath: "Shared Documents/hero.jpg", altText: "Speedwave hero" })',
  outputSchema: {
    type: 'object',
    properties: { success: { type: 'boolean' }, webPartId: { type: 'string' } },
    required: ['success'],
  },
};

const generateTableOfContentsTool: Tool = {
  name: 'generateTableOfContents',
  description:
    "Generate a manual table of contents from a page's text web parts and add it as a new text web part. Microsoft Graph does not expose a native ToC web part, so this scans each textWebPart's innerHtml for `<h1>`–`<h6>` headings (in document order), PATCHes each source web part to inject `id=\"<slug>\"` on headings that lack one (so links resolve), and renders a nested `<ul>` of bookmark links. Section/column index follow the same rules as `addWebPart`. Note: SharePoint's rich-text sanitizer may strip the injected ids in some tenants — in that case the ToC reads but anchors won't click through.",
  inputSchema: {
    type: 'object',
    properties: {
      pageId: { type: 'string' },
      sectionIndex: { type: 'number', minimum: 0, maximum: 20 },
      columnIndex: { type: 'number', minimum: 0, maximum: 10 },
      title: { type: 'string', description: 'Optional `<h2>` rendered above the ToC.' },
      minLevel: {
        type: 'number',
        minimum: 1,
        maximum: 6,
        description: 'Lowest heading level to include (default 1).',
      },
      maxLevel: {
        type: 'number',
        minimum: 1,
        maximum: 6,
        description: 'Highest heading level to include (default 3).',
      },
    },
    required: ['pageId', 'sectionIndex', 'columnIndex'],
  },
  annotations: WRITE_ANNOTATIONS,
  _meta: { deferLoading: false },
  keywords: ['sharepoint', 'pages', 'toc', 'table of contents', 'navigation'],
  example:
    'await sharepoint.generateTableOfContents({ pageId: "abc", sectionIndex: 0, columnIndex: 0, title: "Contents" })',
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      webPartId: { type: 'string' },
      headingCount: { type: 'number' },
      anchorsInjected: {
        type: 'number',
        description: 'Number of source text web parts PATCHed to add heading ids.',
      },
    },
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

interface TitleAreaInput {
  imageWebUrl?: string;
  layout?: string;
  textAlignment?: string;
  enableGradientEffect?: boolean;
  showAuthor?: boolean;
  showPublishedDate?: boolean;
  showTextBlockAboveTitle?: boolean;
  textAboveTitle?: string;
  alternativeText?: string;
}

interface UpdatePageParams {
  pageId: string;
  title?: string;
  description?: string;
  thumbnailWebUrl?: string;
  showComments?: boolean;
  showRecommendedPages?: boolean;
  promotionKind?: 'page' | 'newsPost';
  titleArea?: TitleAreaInput;
  canvasLayout?: CanvasLayout;
}

/**
 * Handler for `updatePage` — PATCH a sitePage (any subset of metadata fields plus canvasLayout).
 * @param client - the SharePoint client
 * @param params - input parameters; pageId is required, every other field is optional
 */
async function handleUpdatePage(
  client: SharePointClient,
  params: UpdatePageParams
): Promise<ToolResult> {
  const idErr = validateGraphId(params.pageId, 'pageId');
  if (idErr) return idErr;

  const body: Record<string, unknown> = {};
  if (params.title !== undefined) body.title = params.title;
  if (params.description !== undefined) body.description = params.description;
  if (params.thumbnailWebUrl !== undefined) body.thumbnailWebUrl = params.thumbnailWebUrl;
  if (params.showComments !== undefined) body.showComments = params.showComments;
  if (params.showRecommendedPages !== undefined) {
    body.showRecommendedPages = params.showRecommendedPages;
  }
  if (params.promotionKind !== undefined) body.promotionKind = params.promotionKind;
  if (params.titleArea !== undefined) {
    body.titleArea = { '@odata.type': '#microsoft.graph.titleArea', ...params.titleArea };
  }
  if (params.canvasLayout !== undefined) body.canvasLayout = params.canvasLayout;

  if (Object.keys(body).length === 0) {
    return wrapErr(
      'UPDATE_PAGE_NO_FIELDS',
      new Error(
        'updatePage requires at least one field besides pageId (title, description, thumbnailWebUrl, showComments, showRecommendedPages, titleArea, or canvasLayout).'
      )
    );
  }

  try {
    await pages(client).patchPage(params.pageId, body);
    return { success: true, data: {} };
  } catch (e) {
    return wrapErr('UPDATE_PAGE_FAILED', e);
  }
}

/**
 * Handler for `addWebPart` — POST a text or standard web part to a column.
 * @param client - the SharePoint client
 * @param params - input parameters
 * @param params.pageId - target page id
 * @param params.sectionIndex - 0-based horizontal section index in the current layout
 * @param params.columnIndex - 0-based column index within that section
 * @param params.innerHtml - HTML body for a text web part (mutually exclusive with `webPartType`)
 * @param params.webPartType - standard web part name (key of STANDARD_WEBPART_TYPES)
 * @param params.data - optional `webPartData` payload for standard web parts
 */
async function handleAddWebPart(
  client: SharePointClient,
  params: {
    pageId: string;
    sectionIndex: number;
    columnIndex: number;
    innerHtml?: string;
    webPartType?: keyof typeof STANDARD_WEBPART_TYPES;
    data?: Record<string, unknown>;
  }
): Promise<ToolResult> {
  const idErr = validateGraphId(params.pageId, 'pageId');
  if (idErr) return idErr;
  // Defense in depth — cap here since `withValidation` skips JSON Schema validation.
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
  if (params.webPartType !== undefined && params.innerHtml !== undefined) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'webPartType and innerHtml are mutually exclusive',
      },
    };
  }
  if (params.webPartType === undefined && params.innerHtml === undefined) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'either innerHtml (text web part) or webPartType (standard web part) is required',
      },
    };
  }
  if (params.innerHtml !== undefined && typeof params.innerHtml !== 'string') {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'innerHtml must be a string' },
    };
  }
  if (params.webPartType !== undefined && !(params.webPartType in STANDARD_WEBPART_TYPES)) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: `webPartType must be one of: ${Object.keys(STANDARD_WEBPART_TYPES).join(', ')}`,
      },
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
    // Graph ids become URL path segments — validate against injection.
    const sectErr = validateGraphId(section.id, 'section.id');
    if (sectErr) return sectErr;
    const colErr = validateGraphId(column.id, 'column.id');
    if (colErr) return colErr;

    const created =
      params.webPartType !== undefined
        ? ((await pagesApi.addStandardWebPart(
            params.pageId,
            section.id,
            column.id,
            STANDARD_WEBPART_TYPES[params.webPartType],
            params.data
          )) as WebPart | undefined)
        : ((await pagesApi.addTextWebPart(
            params.pageId,
            section.id,
            column.id,
            params.innerHtml!
          )) as WebPart | undefined);
    return { success: true, data: { webPartId: created?.id ?? '' } };
  } catch (e) {
    return wrapErr('ADD_WEBPART_FAILED', e);
  }
}

/**
 * Handler for `updateWebPart` — PATCH a text web part directly by id.
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

/**
 * Handler for `generateTableOfContents` — scans text web parts for headings, injects ids for anchor resolution, renders a nested ToC as HTML.
 * @param client - the SharePoint client
 * @param params - input parameters
 * @param params.pageId - target page id
 * @param params.sectionIndex - 0-based section to host the ToC
 * @param params.columnIndex - 0-based column within that section
 * @param params.title - optional header rendered above the ToC
 * @param params.minLevel - lowest heading level to include (default 1)
 * @param params.maxLevel - highest heading level to include (default 3)
 */
async function handleGenerateTableOfContents(
  client: SharePointClient,
  params: {
    pageId: string;
    sectionIndex: number;
    columnIndex: number;
    title?: string;
    minLevel?: number;
    maxLevel?: number;
  }
): Promise<ToolResult> {
  const idErr = validateGraphId(params.pageId, 'pageId');
  if (idErr) return idErr;
  const minLevel = params.minLevel ?? 1;
  const maxLevel = params.maxLevel ?? 3;
  if (minLevel < 1 || minLevel > 6 || maxLevel < 1 || maxLevel > 6 || minLevel > maxLevel) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'minLevel/maxLevel must be 1..6 and minLevel ≤ maxLevel',
      },
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
    const sectErr = validateGraphId(section.id, 'section.id');
    if (sectErr) return sectErr;
    const colErr = validateGraphId(column.id, 'column.id');
    if (colErr) return colErr;

    // Extract headings from text web parts and inject anchor ids where missing.
    const allHeadings = [] as ReturnType<typeof extractHeadings>;
    let anchorsInjected = 0;
    for (const s of sections) {
      for (const c of s.columns ?? []) {
        for (const wp of c.webparts ?? []) {
          if (!wp.innerHtml || !wp.id) continue;
          const wpHeadings = extractHeadings(wp.innerHtml);
          if (wpHeadings.length === 0) continue;
          allHeadings.push(...wpHeadings);
          const rewritten = injectHeadingAnchors(wp.innerHtml, wpHeadings);
          if (rewritten !== wp.innerHtml) {
            const wpIdErr = validateGraphId(wp.id, 'webpart.id');
            if (wpIdErr) return wpIdErr;
            await pagesApi.updateTextWebPart(params.pageId, wp.id, rewritten);
            anchorsInjected++;
          }
        }
      }
    }
    const filtered = allHeadings.filter((h) => h.level >= minLevel && h.level <= maxLevel);
    const html = renderTableOfContents(filtered, params.title);
    if (!html) {
      return {
        success: false,
        error: { code: 'NO_HEADINGS', message: 'no headings found in the page text web parts' },
      };
    }
    const created = (await pagesApi.addTextWebPart(params.pageId, section.id, column.id, html)) as
      | WebPart
      | undefined;
    return {
      success: true,
      data: {
        webPartId: created?.id ?? '',
        headingCount: filtered.length,
        anchorsInjected,
      },
    };
  } catch (e) {
    return wrapErr('GENERATE_TOC_FAILED', e);
  }
}

/**
 * Handler for `addImageWebPart` — adds an image web part backed by a real driveItem from Site Assets or Documents.
 * @param client - the SharePoint client
 * @param params - input parameters
 * @param params.pageId - target page id
 * @param params.sectionIndex - 0-based horizontal section
 * @param params.columnIndex - 0-based column inside the section
 * @param params.sharepointPath - path relative to the drive root (e.g. `Shared Documents/hero.jpg`)
 * @param params.altText - optional alternative text
 * @param params.captionText - optional caption
 * @param params.overlayText - optional overlay text
 * @param params.alignment - "Left" | "Center" | "Right" (default Center)
 * @param params.fixAspectRatio - default false
 */
async function handleAddImageWebPart(
  client: SharePointClient,
  params: {
    pageId: string;
    sectionIndex: number;
    columnIndex: number;
    sharepointPath: string;
    altText?: string;
    captionText?: string;
    overlayText?: string;
    alignment?: 'Left' | 'Center' | 'Right';
    fixAspectRatio?: boolean;
  }
): Promise<ToolResult> {
  const idErr = validateGraphId(params.pageId, 'pageId');
  if (idErr) return idErr;
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
  if (typeof params.sharepointPath !== 'string' || params.sharepointPath.trim() === '') {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'sharepointPath must be a non-empty string' },
    };
  }
  try {
    const driveItem = await client.getDriveItemForSharePointPath(params.sharepointPath);
    if (!driveItem.webUrl) {
      return {
        success: false,
        error: { code: 'DRIVE_ITEM_NO_URL', message: 'driveItem returned no webUrl' },
      };
    }
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
    const sectErr = validateGraphId(section.id, 'section.id');
    if (sectErr) return sectErr;
    const colErr = validateGraphId(column.id, 'column.id');
    if (colErr) return colErr;

    const data = buildImageWebPartData(
      driveItem.webUrl,
      {
        siteId: driveItem.sharepointIds.siteId,
        webId: driveItem.sharepointIds.webId,
        listId: driveItem.sharepointIds.listId,
        listItemUniqueId: driveItem.sharepointIds.listItemUniqueId,
      },
      driveItem.image,
      {
        altText: params.altText,
        captionText: params.captionText,
        overlayText: params.overlayText,
        alignment: params.alignment,
        fixAspectRatio: params.fixAspectRatio,
      }
    );
    const created = (await pagesApi.addStandardWebPart(
      params.pageId,
      section.id,
      column.id,
      STANDARD_WEBPART_TYPES.image,
      data
    )) as WebPart | undefined;
    return { success: true, data: { webPartId: created?.id ?? '' } };
  } catch (e) {
    return wrapErr('ADD_IMAGE_WEBPART_FAILED', e);
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
    {
      tool: generateTableOfContentsTool,
      handler: withValidation<{
        pageId: string;
        sectionIndex: number;
        columnIndex: number;
        title?: string;
        minLevel?: number;
        maxLevel?: number;
      }>(withClient(handleGenerateTableOfContents)),
    },
    {
      tool: addImageWebPartTool,
      handler: withValidation<{
        pageId: string;
        sectionIndex: number;
        columnIndex: number;
        sharepointPath: string;
        altText?: string;
        captionText?: string;
        overlayText?: string;
        alignment?: 'Left' | 'Center' | 'Right';
        fixAspectRatio?: boolean;
      }>(withClient(handleAddImageWebPart)),
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
  generateTableOfContentsTool,
  addImageWebPartTool,
];
