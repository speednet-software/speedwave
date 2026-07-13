/** Tests for SharePoint page tools (PR4 / ADR-060). Web part writes target `/sites/{site-id}/pages/{page-id}/microsoft.graph.sitePage/canvasLayout/...`; MVP scope is `#microsoft.graph.textWebPart` only (other types need per-type GUID-discriminated payloads, out of scope for PR4).
 * Covers: metadata/schema invariants, site-policy by omission (no tool accepts `site_id` — always derived via `client.getSiteId()`), happy path for all 8 handlers, and error paths (range, INVALID_ID, NOT_CONFIGURED). */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolsCallResult } from '@speedwave/mcp-shared';
import { SharePointClient } from '../client.js';
import { createPageTools, PAGE_TOOL_SCHEMAS, type SitePage } from './page-tools.js';
import {
  buildTextWebPartBody,
  buildStandardWebPartBody,
  STANDARD_WEBPART_TYPES,
} from '../graph/pages-client.js';

const MOCK_SITE_ID = 'speednet.sharepoint.com,abc,def';

/** Create a SharePointClient stub with controllable graphRequest. */
function createMockClient(
  graphRequestImpl: (method: string, url: string, body?: unknown) => Promise<unknown> = async () =>
    undefined,
  extras: Partial<Record<keyof SharePointClient, unknown>> = {}
): SharePointClient {
  return {
    getSiteId: () => MOCK_SITE_ID,
    graphRequest: vi.fn(graphRequestImpl),
    ...extras,
  } as unknown as SharePointClient;
}

function parseContent(result: ToolsCallResult): unknown {
  const first = result.content?.[0];
  const text = first?.type === 'text' && typeof first.text === 'string' ? first.text : '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

describe('page-tools metadata', () => {
  it('exposes exactly 10 tools', () => {
    expect(PAGE_TOOL_SCHEMAS).toHaveLength(10);
  });

  it('all 10 tool names match the contract', () => {
    const names = PAGE_TOOL_SCHEMAS.map((t) => t.name);
    expect(names).toEqual([
      'listPages',
      'getPage',
      'createPage',
      'updatePage',
      'addWebPart',
      'updateWebPart',
      'removeWebPart',
      'publishPage',
      'generateTableOfContents',
      'addImageWebPart',
    ]);
  });

  // Regression: no page tool accepts site_id (security invariant per ADR-060).
  it('NO page tool accepts site_id from the model', () => {
    for (const tool of PAGE_TOOL_SCHEMAS) {
      const schema = tool.inputSchema as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      const propKeys = Object.keys(schema.properties ?? {});
      expect(propKeys, `${tool.name} has site_id`).not.toContain('site_id');
      expect(propKeys, `${tool.name} has siteId`).not.toContain('siteId');
      expect(schema.required ?? [], `${tool.name} requires site_id`).not.toContain('site_id');
      expect(schema.required ?? [], `${tool.name} requires siteId`).not.toContain('siteId');
    }
  });

  it('write tools have WRITE_ANNOTATIONS, read tools have READ_ONLY_ANNOTATIONS', () => {
    const readOnly = new Set(['listPages', 'getPage']);
    for (const tool of PAGE_TOOL_SCHEMAS) {
      if (readOnly.has(tool.name)) {
        expect(tool.annotations?.readOnlyHint, `${tool.name} should be read-only`).toBe(true);
      } else {
        expect(
          tool.annotations?.destructiveHint ?? false,
          `${tool.name} write annotation`
        ).toBeDefined();
      }
    }
  });

  it('addWebPart exposes both text and standard web part inputs', () => {
    const tool = PAGE_TOOL_SCHEMAS.find((t) => t.name === 'addWebPart')!;
    const schema = tool.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining([
        'pageId',
        'sectionIndex',
        'columnIndex',
        'innerHtml',
        'webPartType',
        'data',
      ])
    );
    // innerHtml / webPartType are mutually exclusive — both opt-in, handler enforces exactly-one.
    expect(schema.required).not.toContain('innerHtml');
    expect(schema.required).not.toContain('webPartType');
    expect(schema.required).toEqual(['pageId', 'sectionIndex', 'columnIndex']);
  });

  it('updateWebPart input requires innerHtml (text-only MVP)', () => {
    const tool = PAGE_TOOL_SCHEMAS.find((t) => t.name === 'updateWebPart')!;
    const schema = tool.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['pageId', 'webPartId', 'innerHtml'])
    );
    expect(schema.required).toContain('innerHtml');
  });

  it('addWebPart caps section/column index in schema (OOM defense in depth)', () => {
    const tool = PAGE_TOOL_SCHEMAS.find((t) => t.name === 'addWebPart')!;
    const schema = tool.inputSchema as unknown as {
      properties: { sectionIndex: { maximum: number }; columnIndex: { maximum: number } };
    };
    expect(schema.properties.sectionIndex.maximum).toBe(20);
    expect(schema.properties.columnIndex.maximum).toBe(10);
  });
});

describe('page-tools handlers — happy paths', () => {
  let graph: ReturnType<typeof vi.fn>;
  let client: SharePointClient;

  beforeEach(() => {
    graph = vi.fn();
    client = createMockClient(graph as unknown as Parameters<typeof createMockClient>[0]);
  });

  it('listPages returns projected page list', async () => {
    graph.mockResolvedValueOnce({
      value: [
        { id: 'p1', name: 'p1.aspx', title: 'Page 1', webUrl: 'https://s/p1.aspx' },
        { id: 'p2', name: 'p2.aspx', title: 'Page 2', webUrl: 'https://s/p2.aspx' },
      ],
    });
    const tools = createPageTools(client);
    const listPages = tools.find((t) => t.tool.name === 'listPages')!;
    const out = parseContent(await listPages.handler({})) as {
      pages: Array<{ id: string }>;
    };
    expect(out.pages).toHaveLength(2);
    expect(out.pages[0].id).toBe('p1');
    // Verify the URL has the site id derived from the worker, not from the caller.
    expect(graph).toHaveBeenCalledWith(
      'GET',
      expect.stringContaining(`/sites/${MOCK_SITE_ID}/pages/microsoft.graph.sitePage`)
    );
  });

  it('getPage expands canvasLayout', async () => {
    const fakePage: SitePage = {
      id: 'p1',
      title: 'P1',
      canvasLayout: { horizontalSections: [] },
    };
    graph.mockResolvedValueOnce(fakePage);
    const tools = createPageTools(client);
    const getPage = tools.find((t) => t.tool.name === 'getPage')!;
    const out = parseContent(await getPage.handler({ pageId: 'p1' })) as {
      page: SitePage;
    };
    expect(out.page.id).toBe('p1');
    expect(graph.mock.calls[0][1]).toContain('$expand=canvasLayout');
  });

  it('createPage POSTs with odata.type and returns id/webUrl', async () => {
    graph.mockResolvedValueOnce({ id: 'new-1', webUrl: 'https://s/new-1.aspx' });
    const tools = createPageTools(client);
    const createPage = tools.find((t) => t.tool.name === 'createPage')!;
    const out = parseContent(await createPage.handler({ title: 'Hi', name: 'hi.aspx' })) as {
      pageId: string;
      webUrl: string;
    };
    expect(out.pageId).toBe('new-1');
    expect(out.webUrl).toBe('https://s/new-1.aspx');
    const [method, url, body] = graph.mock.calls[0];
    expect(method).toBe('POST');
    expect(url).toBe(`/sites/${MOCK_SITE_ID}/pages`);
    expect(body).toMatchObject({
      '@odata.type': '#microsoft.graph.sitePage',
      title: 'Hi',
      name: 'hi.aspx',
    });
  });

  it('updatePage PATCHes the full canvasLayout', async () => {
    graph.mockResolvedValueOnce(undefined);
    const layout = {
      horizontalSections: [{ id: 'sec1', columns: [{ id: 'col1', webparts: [] }] }],
    };
    const tools = createPageTools(client);
    const updatePage = tools.find((t) => t.tool.name === 'updatePage')!;
    const out = parseContent(await updatePage.handler({ pageId: 'p1', canvasLayout: layout }));
    expect(out).toEqual({});
    const [method, url, body] = graph.mock.calls[0];
    expect(method).toBe('PATCH');
    expect(url).toBe(`/sites/${MOCK_SITE_ID}/pages/p1/microsoft.graph.sitePage`);
    expect(body).toEqual({ canvasLayout: layout });
  });

  it('updatePage PATCHes metadata-only updates without canvasLayout', async () => {
    graph.mockResolvedValueOnce(undefined);
    const tools = createPageTools(client);
    const updatePage = tools.find((t) => t.tool.name === 'updatePage')!;
    const out = parseContent(
      await updatePage.handler({
        pageId: 'p1',
        title: 'New title',
        description: 'New description',
        showComments: false,
        showRecommendedPages: true,
        thumbnailWebUrl: 'https://contoso.sharepoint.com/_layouts/SitePages/thumb.png',
      })
    );
    expect(out).toEqual({});
    const [method, url, body] = graph.mock.calls[0];
    expect(method).toBe('PATCH');
    expect(url).toBe(`/sites/${MOCK_SITE_ID}/pages/p1/microsoft.graph.sitePage`);
    expect(body).toEqual({
      title: 'New title',
      description: 'New description',
      showComments: false,
      showRecommendedPages: true,
      thumbnailWebUrl: 'https://contoso.sharepoint.com/_layouts/SitePages/thumb.png',
    });
  });

  it('updatePage wraps titleArea with the Graph @odata.type discriminator', async () => {
    graph.mockResolvedValueOnce(undefined);
    const tools = createPageTools(client);
    const updatePage = tools.find((t) => t.tool.name === 'updatePage')!;
    await updatePage.handler({
      pageId: 'p1',
      titleArea: {
        imageWebUrl: 'https://contoso.sharepoint.com/_layouts/SitePages/hero.jpg',
        layout: 'imageAndTitle',
        textAlignment: 'center',
        showAuthor: false,
      },
    });
    const [, , body] = graph.mock.calls[0];
    expect(body).toEqual({
      titleArea: {
        '@odata.type': '#microsoft.graph.titleArea',
        imageWebUrl: 'https://contoso.sharepoint.com/_layouts/SitePages/hero.jpg',
        layout: 'imageAndTitle',
        textAlignment: 'center',
        showAuthor: false,
      },
    });
  });

  it('updatePage accepts both metadata and canvasLayout in one call', async () => {
    graph.mockResolvedValueOnce(undefined);
    const tools = createPageTools(client);
    const updatePage = tools.find((t) => t.tool.name === 'updatePage')!;
    const layout = {
      horizontalSections: [{ id: 'sec1', columns: [{ id: 'col1', webparts: [] }] }],
    };
    await updatePage.handler({ pageId: 'p1', title: 'X', canvasLayout: layout });
    const [, , body] = graph.mock.calls[0];
    expect(body).toEqual({ title: 'X', canvasLayout: layout });
  });

  it('updatePage promotes a page to news via promotionKind', async () => {
    graph.mockResolvedValueOnce(undefined);
    const tools = createPageTools(client);
    const updatePage = tools.find((t) => t.tool.name === 'updatePage')!;
    await updatePage.handler({ pageId: 'p1', promotionKind: 'newsPost' });
    const [, , body] = graph.mock.calls[0];
    expect(body).toEqual({ promotionKind: 'newsPost' });
  });

  it('updatePage rejects calls that only carry pageId', async () => {
    const tools = createPageTools(client);
    const updatePage = tools.find((t) => t.tool.name === 'updatePage')!;
    const result = await updatePage.handler({ pageId: 'p1' });
    expect(result.isError).toBe(true);
    const parsed = parseContent(result) as { code: string };
    expect(parsed.code).toBe('UPDATE_PAGE_NO_FIELDS');
    expect(graph).not.toHaveBeenCalled();
  });

  it('addWebPart resolves section/column index to Graph ids and POSTs a textWebPart', async () => {
    graph
      .mockResolvedValueOnce({
        id: 'p1',
        canvasLayout: {
          horizontalSections: [
            {
              id: 'sec-id-1',
              columns: [{ id: 'col-id-1', webparts: [] }],
            },
          ],
        },
      })
      .mockResolvedValueOnce({ id: 'wp-created-1' });
    const tools = createPageTools(client);
    const addWebPart = tools.find((t) => t.tool.name === 'addWebPart')!;
    const out = parseContent(
      await addWebPart.handler({
        pageId: 'p1',
        sectionIndex: 0,
        columnIndex: 0,
        innerHtml: '<p>Hi</p>',
      })
    ) as { webPartId: string };
    expect(out.webPartId).toBe('wp-created-1');
    expect(graph.mock.calls).toHaveLength(2);
    const [postMethod, postUrl, postBody] = graph.mock.calls[1];
    expect(postMethod).toBe('POST');
    expect(postUrl).toBe(
      `/sites/${MOCK_SITE_ID}/pages/p1/microsoft.graph.sitePage` +
        `/canvasLayout/horizontalSections/sec-id-1/columns/col-id-1/webparts`
    );
    expect(postBody).toEqual(buildTextWebPartBody('<p>Hi</p>'));
  });

  it('addWebPart POSTs a standardWebPart envelope when webPartType is given', async () => {
    graph
      .mockResolvedValueOnce({
        id: 'p1',
        canvasLayout: {
          horizontalSections: [{ id: 'sec-id-1', columns: [{ id: 'col-id-1', webparts: [] }] }],
        },
      })
      .mockResolvedValueOnce({ id: 'wp-image' });
    const tools = createPageTools(client);
    const addWebPart = tools.find((t) => t.tool.name === 'addWebPart')!;
    const out = parseContent(
      await addWebPart.handler({
        pageId: 'p1',
        sectionIndex: 0,
        columnIndex: 0,
        webPartType: 'image',
        data: { title: 'Hero' },
      })
    ) as { webPartId: string };
    expect(out.webPartId).toBe('wp-image');
    const [, , body] = graph.mock.calls[1];
    expect(body).toEqual(buildStandardWebPartBody(STANDARD_WEBPART_TYPES.image, { title: 'Hero' }));
  });

  it('addWebPart rejects when both innerHtml and webPartType are supplied', async () => {
    const tools = createPageTools(client);
    const addWebPart = tools.find((t) => t.tool.name === 'addWebPart')!;
    const result = await addWebPart.handler({
      pageId: 'p1',
      sectionIndex: 0,
      columnIndex: 0,
      innerHtml: '<p>x</p>',
      webPartType: 'image',
    });
    expect(result.isError).toBe(true);
    const parsed = parseContent(result) as { code: string };
    expect(parsed.code).toBe('INVALID_INPUT');
    expect(graph).not.toHaveBeenCalled();
  });

  it('addWebPart rejects when neither innerHtml nor webPartType are supplied', async () => {
    const tools = createPageTools(client);
    const addWebPart = tools.find((t) => t.tool.name === 'addWebPart')!;
    const result = await addWebPart.handler({
      pageId: 'p1',
      sectionIndex: 0,
      columnIndex: 0,
    });
    expect(result.isError).toBe(true);
    const parsed = parseContent(result) as { code: string };
    expect(parsed.code).toBe('INVALID_INPUT');
    expect(graph).not.toHaveBeenCalled();
  });

  it('addWebPart rejects unknown webPartType', async () => {
    const tools = createPageTools(client);
    const addWebPart = tools.find((t) => t.tool.name === 'addWebPart')!;
    const result = await addWebPart.handler({
      pageId: 'p1',
      sectionIndex: 0,
      columnIndex: 0,
      webPartType: 'bogus' as unknown as keyof typeof STANDARD_WEBPART_TYPES,
    });
    expect(result.isError).toBe(true);
    const parsed = parseContent(result) as { code: string };
    expect(parsed.code).toBe('INVALID_INPUT');
  });

  it('addWebPart errors with SECTION_OUT_OF_RANGE when sectionIndex points past the layout', async () => {
    graph.mockResolvedValueOnce({
      id: 'p1',
      canvasLayout: { horizontalSections: [] },
    });
    const tools = createPageTools(client);
    const addWebPart = tools.find((t) => t.tool.name === 'addWebPart')!;
    const result = await addWebPart.handler({
      pageId: 'p1',
      sectionIndex: 0,
      columnIndex: 0,
      innerHtml: '<p>x</p>',
    });
    expect(result.isError).toBe(true);
    const parsed = parseContent(result) as { code: string };
    expect(parsed.code).toBe('SECTION_OUT_OF_RANGE');
    // Did the GET, did not POST.
    expect(graph.mock.calls).toHaveLength(1);
  });

  it('addWebPart errors with COLUMN_OUT_OF_RANGE when section has fewer columns', async () => {
    graph.mockResolvedValueOnce({
      id: 'p1',
      canvasLayout: {
        horizontalSections: [{ id: 'sec1', columns: [{ id: 'c1' }] }],
      },
    });
    const tools = createPageTools(client);
    const addWebPart = tools.find((t) => t.tool.name === 'addWebPart')!;
    const result = await addWebPart.handler({
      pageId: 'p1',
      sectionIndex: 0,
      columnIndex: 5,
      innerHtml: '<p>x</p>',
    });
    expect(result.isError).toBe(true);
    const parsed = parseContent(result) as { code: string };
    expect(parsed.code).toBe('COLUMN_OUT_OF_RANGE');
  });

  it('addWebPart rejects huge sectionIndex with INVALID_INDEX (OOM guard)', async () => {
    const tools = createPageTools(client);
    const addWebPart = tools.find((t) => t.tool.name === 'addWebPart')!;
    const result = await addWebPart.handler({
      pageId: 'p1',
      sectionIndex: 2_000_000_000,
      columnIndex: 0,
      innerHtml: '<p>x</p>',
    });
    expect(result.isError).toBe(true);
    const parsed = parseContent(result) as { code: string };
    expect(parsed.code).toBe('INVALID_INDEX');
    // Never reached Graph
    expect(graph).not.toHaveBeenCalled();
  });

  it('addWebPart rejects huge columnIndex with INVALID_INDEX (OOM guard)', async () => {
    const tools = createPageTools(client);
    const addWebPart = tools.find((t) => t.tool.name === 'addWebPart')!;
    const result = await addWebPart.handler({
      pageId: 'p1',
      sectionIndex: 0,
      columnIndex: 999,
      innerHtml: '<p>x</p>',
    });
    expect(result.isError).toBe(true);
    const parsed = parseContent(result) as { code: string };
    expect(parsed.code).toBe('INVALID_INDEX');
  });

  it('addWebPart rejects negative or non-integer indices', async () => {
    const tools = createPageTools(client);
    const addWebPart = tools.find((t) => t.tool.name === 'addWebPart')!;
    for (const bad of [-1, 0.5, NaN]) {
      const result = await addWebPart.handler({
        pageId: 'p1',
        sectionIndex: bad,
        columnIndex: 0,
        innerHtml: '<p>x</p>',
      });
      expect(result.isError, `index=${bad}`).toBe(true);
    }
  });

  it('updateWebPart PATCHes the textWebPart at the dedicated Graph endpoint', async () => {
    graph.mockResolvedValueOnce(undefined);
    const tools = createPageTools(client);
    const updateWebPart = tools.find((t) => t.tool.name === 'updateWebPart')!;
    const out = parseContent(
      await updateWebPart.handler({
        pageId: 'p1',
        webPartId: 'wp-x',
        innerHtml: '<p>new</p>',
      })
    );
    expect(out).toEqual({});
    expect(graph.mock.calls).toHaveLength(1);
    const [method, url, body] = graph.mock.calls[0];
    expect(method).toBe('PATCH');
    expect(url).toBe(`/sites/${MOCK_SITE_ID}/pages/p1/microsoft.graph.sitePage/webParts/wp-x`);
    expect(body).toEqual(buildTextWebPartBody('<p>new</p>'));
  });

  it('removeWebPart DELETEs at the documented `/webParts/{id}` endpoint', async () => {
    graph.mockResolvedValueOnce(undefined);
    const tools = createPageTools(client);
    const removeWebPart = tools.find((t) => t.tool.name === 'removeWebPart')!;
    await removeWebPart.handler({ pageId: 'p1', webPartId: 'wp-1' });
    expect(graph.mock.calls).toHaveLength(1);
    const [method, url] = graph.mock.calls[0];
    expect(method).toBe('DELETE');
    expect(url).toBe(`/sites/${MOCK_SITE_ID}/pages/p1/microsoft.graph.sitePage/webParts/wp-1`);
  });

  // A swapped sourceTool would point the model at the wrong follow-up tool.
  it.each([
    [
      'updateWebPart',
      { pageId: 'bad/../path', webPartId: 'wp-x', innerHtml: '<p>x</p>' },
      'listPages',
    ],
    ['updateWebPart', { pageId: 'p1', webPartId: 'bad/../path', innerHtml: '<p>x</p>' }, 'getPage'],
    ['removeWebPart', { pageId: 'bad/../path', webPartId: 'wp-1' }, 'listPages'],
    ['removeWebPart', { pageId: 'p1', webPartId: 'bad/../path' }, 'getPage'],
  ] as const)(
    '%s INVALID_ID message names the sourceTool that supplies a valid id',
    async (toolName, params, sourceTool) => {
      const tools = createPageTools(client);
      const result = await tools.find((t) => t.tool.name === toolName)!.handler(params);
      expect(result.isError).toBe(true);
      const parsed = parseContent(result) as { code: string; message: string };
      expect(parsed.code).toBe('INVALID_ID');
      expect(parsed.message).toContain(sourceTool);
      expect(graph).not.toHaveBeenCalled();
    }
  );

  it('publishPage POSTs to the publish endpoint', async () => {
    graph.mockResolvedValueOnce(undefined);
    const tools = createPageTools(client);
    const publishPage = tools.find((t) => t.tool.name === 'publishPage')!;
    const out = parseContent(await publishPage.handler({ pageId: 'p1' }));
    expect(out).toEqual({});
    expect(graph).toHaveBeenCalledWith(
      'POST',
      `/sites/${MOCK_SITE_ID}/pages/p1/microsoft.graph.sitePage/publish`
    );
  });

  it('addImageWebPart pins payload to a driveItem (sharepointIds + image dims)', async () => {
    const driveItem = {
      id: 'item-1',
      name: 'hero.jpg',
      webUrl: 'https://contoso.sharepoint.com/sites/x/Shared%20Documents/hero.jpg',
      image: { width: 1920, height: 1080 },
      sharepointIds: {
        siteId: 'site-guid',
        webId: 'web-guid',
        listId: 'list-guid',
        listItemUniqueId: 'item-unique-guid',
      },
    };
    const getDriveItem = vi.fn().mockResolvedValue(driveItem);
    const localGraph = vi
      .fn()
      // 1) getPage
      .mockResolvedValueOnce({
        id: 'p1',
        canvasLayout: {
          horizontalSections: [{ id: 'sec-1', columns: [{ id: 'col-1', webparts: [] }] }],
        },
      })
      // 2) addStandardWebPart
      .mockResolvedValueOnce({ id: 'wp-image' });
    const c = createMockClient(localGraph as unknown as Parameters<typeof createMockClient>[0], {
      getDriveItemForSharePointPath: getDriveItem,
    });
    const tools = createPageTools(c);
    const tool = tools.find((t) => t.tool.name === 'addImageWebPart')!;
    const out = parseContent(
      await tool.handler({
        pageId: 'p1',
        sectionIndex: 0,
        columnIndex: 0,
        sharepointPath: 'Shared Documents/hero.jpg',
        altText: 'Hero',
      })
    ) as { webPartId: string };
    expect(out.webPartId).toBe('wp-image');
    expect(getDriveItem).toHaveBeenCalledWith('Shared Documents/hero.jpg');

    const [, , body] = localGraph.mock.calls[1];
    // Body embeds driveItem ids for SharePoint UI reconciliation.
    const properties = (
      body as { webPartProperties?: unknown; data?: { properties: Record<string, unknown> } }
    ).data?.properties;
    expect(properties).toMatchObject({
      siteid: 'site-guid',
      webid: 'web-guid',
      listid: 'list-guid',
      uniqueid: 'item-unique-guid',
      imgWidth: 1920,
      imgHeight: 1080,
      altText: 'Hero',
      imageSourceType: 2,
    });
  });

  it('addImageWebPart rejects when driveItem has no webUrl', async () => {
    const getDriveItem = vi.fn().mockResolvedValue({
      id: 'item-1',
      name: 'hero.jpg',
      sharepointIds: { siteId: 's', webId: 'w', listId: 'l', listItemUniqueId: 'u' },
    });
    const c = createMockClient(undefined, {
      getDriveItemForSharePointPath: getDriveItem,
    });
    const tools = createPageTools(c);
    const tool = tools.find((t) => t.tool.name === 'addImageWebPart')!;
    const result = await tool.handler({
      pageId: 'p1',
      sectionIndex: 0,
      columnIndex: 0,
      sharepointPath: 'X/y.jpg',
    });
    expect(result.isError).toBe(true);
    expect((parseContent(result) as { code: string }).code).toBe('DRIVE_ITEM_NO_URL');
  });

  it('addImageWebPart validates empty sharepointPath without touching Graph', async () => {
    const getDriveItem = vi.fn();
    const c = createMockClient(undefined, {
      getDriveItemForSharePointPath: getDriveItem,
    });
    const tools = createPageTools(c);
    const tool = tools.find((t) => t.tool.name === 'addImageWebPart')!;
    const result = await tool.handler({
      pageId: 'p1',
      sectionIndex: 0,
      columnIndex: 0,
      sharepointPath: '',
    });
    expect(result.isError).toBe(true);
    expect((parseContent(result) as { code: string }).code).toBe('INVALID_INPUT');
    expect(getDriveItem).not.toHaveBeenCalled();
  });

  it('addImageWebPart returns COLUMN_OUT_OF_RANGE when the column index does not exist', async () => {
    // Column-index bounds prevent wasted Graph round-trips.
    const driveItem = {
      id: 'item-1',
      webUrl: 'https://example/hero.jpg',
      image: { width: 100, height: 100 },
      sharepointIds: { siteId: 's', webId: 'w', listId: 'l', listItemUniqueId: 'u' },
    };
    const localGraph = vi.fn().mockResolvedValueOnce({
      id: 'p1',
      canvasLayout: {
        horizontalSections: [{ id: 'sec-1', columns: [{ id: 'col-1', webparts: [] }] }],
      },
    });
    const c = createMockClient(localGraph as unknown as Parameters<typeof createMockClient>[0], {
      getDriveItemForSharePointPath: vi.fn().mockResolvedValue(driveItem),
    });
    const tools = createPageTools(c);
    const tool = tools.find((t) => t.tool.name === 'addImageWebPart')!;
    const result = await tool.handler({
      pageId: 'p1',
      sectionIndex: 0,
      columnIndex: 5, // out of range — section has 1 column
      sharepointPath: 'X/y.jpg',
    });
    expect(result.isError).toBe(true);
    const err = parseContent(result) as { code: string; message: string };
    expect(err.code).toBe('COLUMN_OUT_OF_RANGE');
    expect(err.message).toMatch(/columnIndex 5 not present \(section has 1\)/);
  });

  it('addImageWebPart rejects out-of-range section/column indexes before any Graph call', async () => {
    // Handler validates index bounds before driveItem lookup.
    const getDriveItem = vi.fn();
    const c = createMockClient(undefined, { getDriveItemForSharePointPath: getDriveItem });
    const tools = createPageTools(c);
    const tool = tools.find((t) => t.tool.name === 'addImageWebPart')!;

    for (const params of [
      { sectionIndex: 999, columnIndex: 0 },
      { sectionIndex: 0, columnIndex: 999 },
    ]) {
      const result = await tool.handler({
        pageId: 'p1',
        sharepointPath: 'X/y.jpg',
        ...params,
      });
      expect(result.isError).toBe(true);
      expect((parseContent(result) as { code: string }).code).toBe('INVALID_INDEX');
    }
    expect(getDriveItem).not.toHaveBeenCalled();
  });

  it('addImageWebPart returns NOT_FOUND when the page does not exist', async () => {
    const driveItem = {
      id: 'i',
      webUrl: 'https://example/x.jpg',
      image: { width: 1, height: 1 },
      sharepointIds: { siteId: 's', webId: 'w', listId: 'l', listItemUniqueId: 'u' },
    };
    const localGraph = vi.fn().mockResolvedValueOnce(undefined); // getPage returns undefined
    const c = createMockClient(localGraph as unknown as Parameters<typeof createMockClient>[0], {
      getDriveItemForSharePointPath: vi.fn().mockResolvedValue(driveItem),
    });
    const tools = createPageTools(c);
    const tool = tools.find((t) => t.tool.name === 'addImageWebPart')!;
    const result = await tool.handler({
      pageId: 'missing',
      sectionIndex: 0,
      columnIndex: 0,
      sharepointPath: 'X/y.jpg',
    });
    expect(result.isError).toBe(true);
    expect((parseContent(result) as { code: string }).code).toBe('NOT_FOUND');
  });

  it('addImageWebPart wraps unexpected driveItem-lookup errors as ADD_IMAGE_WEBPART_FAILED', async () => {
    // Unexpected driveItem-lookup throws surface with a stable error code.
    const getDriveItem = vi.fn().mockRejectedValue(new Error('Graph 503 Service Unavailable'));
    const c = createMockClient(undefined, {
      getDriveItemForSharePointPath: getDriveItem,
    });
    const tools = createPageTools(c);
    const tool = tools.find((t) => t.tool.name === 'addImageWebPart')!;
    const result = await tool.handler({
      pageId: 'p1',
      sectionIndex: 0,
      columnIndex: 0,
      sharepointPath: 'X/y.jpg',
    });
    expect(result.isError).toBe(true);
    const err = parseContent(result) as { code: string; message: string };
    expect(err.code).toBe('ADD_IMAGE_WEBPART_FAILED');
    expect(err.message).toMatch(/Graph 503 Service Unavailable/);
  });
});

describe('page-tools handlers — error paths', () => {
  it('addWebPart surfaces Graph errors with ADD_WEBPART_FAILED', async () => {
    const graph = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'p1',
        canvasLayout: {
          horizontalSections: [{ id: 'sec1', columns: [{ id: 'col1', webparts: [] }] }],
        },
      })
      .mockRejectedValueOnce(new Error('Graph 500'));
    const client = createMockClient(graph as unknown as Parameters<typeof createMockClient>[0]);
    const tools = createPageTools(client);
    const addWebPart = tools.find((t) => t.tool.name === 'addWebPart')!;
    const result = await addWebPart.handler({
      pageId: 'p1',
      sectionIndex: 0,
      columnIndex: 0,
      innerHtml: '<p>x</p>',
    });
    expect(result.isError).toBe(true);
    const parsed = parseContent(result) as { code: string };
    expect(parsed.code).toBe('ADD_WEBPART_FAILED');
  });

  it('updateWebPart surfaces Graph errors with UPDATE_WEBPART_FAILED', async () => {
    const graph = vi.fn().mockRejectedValueOnce(new Error('Graph 404'));
    const client = createMockClient(graph as unknown as Parameters<typeof createMockClient>[0]);
    const tools = createPageTools(client);
    const updateWebPart = tools.find((t) => t.tool.name === 'updateWebPart')!;
    const result = await updateWebPart.handler({
      pageId: 'p1',
      webPartId: 'wp-x',
      innerHtml: '<p>x</p>',
    });
    expect(result.isError).toBe(true);
    const parsed = parseContent(result) as { code: string };
    expect(parsed.code).toBe('UPDATE_WEBPART_FAILED');
  });

  it('removeWebPart surfaces Graph errors with REMOVE_WEBPART_FAILED', async () => {
    const graph = vi.fn().mockRejectedValueOnce(new Error('Graph 404'));
    const client = createMockClient(graph as unknown as Parameters<typeof createMockClient>[0]);
    const tools = createPageTools(client);
    const removeWebPart = tools.find((t) => t.tool.name === 'removeWebPart')!;
    const result = await removeWebPart.handler({ pageId: 'p1', webPartId: 'wp-x' });
    expect(result.isError).toBe(true);
    const parsed = parseContent(result) as { code: string };
    expect(parsed.code).toBe('REMOVE_WEBPART_FAILED');
  });

  it('listPages surfaces Graph errors with LIST_PAGES_FAILED', async () => {
    const graph = vi.fn().mockRejectedValueOnce(new Error('Graph 500'));
    const client = createMockClient(graph as unknown as Parameters<typeof createMockClient>[0]);
    const tools = createPageTools(client);
    const listPages = tools.find((t) => t.tool.name === 'listPages')!;
    const result = await listPages.handler({});
    expect(result.isError).toBe(true);
    const parsed = parseContent(result) as { code: string };
    expect(parsed.code).toBe('LIST_PAGES_FAILED');
  });

  // Table-driven Graph-500 error tests covering every wrapErr code.
  it.each([
    ['getPage', { pageId: 'p1' }, 'GET_PAGE_FAILED'],
    ['createPage', { title: 'Hi', name: 'hi.aspx' }, 'CREATE_PAGE_FAILED'],
    [
      'updatePage',
      { pageId: 'p1', canvasLayout: { horizontalSections: [] } },
      'UPDATE_PAGE_FAILED',
    ],
    ['publishPage', { pageId: 'p1' }, 'PUBLISH_PAGE_FAILED'],
  ] as const)('%s surfaces Graph errors with %s', async (toolName, params, code) => {
    const graph = vi.fn().mockRejectedValueOnce(new Error('Graph 500'));
    const client = createMockClient(graph as unknown as Parameters<typeof createMockClient>[0]);
    const tools = createPageTools(client);
    const result = await tools.find((t) => t.tool.name === toolName)!.handler(params);
    expect(result.isError).toBe(true);
    expect((parseContent(result) as { code: string }).code).toBe(code);
  });

  it('createPage with canvasLayout passes it through (covers the `if` branch)', async () => {
    const graph = vi.fn().mockResolvedValueOnce({ id: 'p-new' });
    const client = createMockClient(graph as unknown as Parameters<typeof createMockClient>[0]);
    const tools = createPageTools(client);
    await tools
      .find((t) => t.tool.name === 'createPage')!
      .handler({
        title: 'Hi',
        name: 'hi.aspx',
        canvasLayout: { horizontalSections: [] },
      });
    const [, , body] = graph.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(body).toHaveProperty('canvasLayout');
  });

  it('addWebPart returns NOT_FOUND when getPage resolves to undefined', async () => {
    // The defensive `if (!page)` branch — Graph returned 204 / null layout.
    const graph = vi.fn().mockResolvedValueOnce(undefined);
    const client = createMockClient(graph as unknown as Parameters<typeof createMockClient>[0]);
    const tools = createPageTools(client);
    const result = await tools
      .find((t) => t.tool.name === 'addWebPart')!
      .handler({
        pageId: 'p1',
        sectionIndex: 0,
        columnIndex: 0,
        innerHtml: '<p>x</p>',
      });
    expect(result.isError).toBe(true);
    expect((parseContent(result) as { code: string }).code).toBe('NOT_FOUND');
  });

  it('addWebPart rejects non-string innerHtml with INVALID_INPUT', async () => {
    const tools = createPageTools(createMockClient());
    const result = await tools
      .find((t) => t.tool.name === 'addWebPart')!
      .handler({
        pageId: 'p1',
        sectionIndex: 0,
        columnIndex: 0,
        innerHtml: 42 as unknown as string,
      });
    expect(result.isError).toBe(true);
    expect((parseContent(result) as { code: string }).code).toBe('INVALID_INPUT');
  });

  it('updateWebPart rejects non-string innerHtml with INVALID_INPUT', async () => {
    const tools = createPageTools(createMockClient());
    const result = await tools
      .find((t) => t.tool.name === 'updateWebPart')!
      .handler({
        pageId: 'p1',
        webPartId: 'wp-1',
        innerHtml: null as unknown as string,
      });
    expect(result.isError).toBe(true);
    expect((parseContent(result) as { code: string }).code).toBe('INVALID_INPUT');
  });

  // Per-tool pageId / webPartId validateGraphId rejections.
  it.each([
    [
      'addWebPart',
      { pageId: 'bad/../path', sectionIndex: 0, columnIndex: 0, innerHtml: '<p>x</p>' },
    ],
    ['publishPage', { pageId: 'bad/../path' }],
    ['updateWebPart', { pageId: 'bad/../path', webPartId: 'wp1', innerHtml: '<p>x</p>' }],
    ['updateWebPart', { pageId: 'p1', webPartId: 'wp/../bad', innerHtml: '<p>x</p>' }],
    ['removeWebPart', { pageId: 'bad/../path', webPartId: 'wp1' }],
  ] as const)('%s rejects malformed ids with INVALID_ID', async (toolName, params) => {
    const graph = vi.fn();
    const client = createMockClient(graph as unknown as Parameters<typeof createMockClient>[0]);
    const tools = createPageTools(client);
    const result = await tools.find((t) => t.tool.name === toolName)!.handler(params);
    expect(result.isError).toBe(true);
    expect((parseContent(result) as { code: string }).code).toBe('INVALID_ID');
    expect(graph).not.toHaveBeenCalled();
  });

  it('addWebPart rejects malformed section.id from Graph response (defense-in-depth)', async () => {
    // Defense-in-depth: validate Graph ids before URL stitching.
    const graph = vi.fn().mockResolvedValueOnce({
      id: 'p1',
      canvasLayout: {
        horizontalSections: [{ id: 'sec/../bad', columns: [{ id: 'c1', webparts: [] }] }],
      },
    });
    const client = createMockClient(graph as unknown as Parameters<typeof createMockClient>[0]);
    const tools = createPageTools(client);
    const result = await tools
      .find((t) => t.tool.name === 'addWebPart')!
      .handler({
        pageId: 'p1',
        sectionIndex: 0,
        columnIndex: 0,
        innerHtml: '<p>x</p>',
      });
    expect(result.isError).toBe(true);
    expect((parseContent(result) as { code: string }).code).toBe('INVALID_ID');
  });

  it('addWebPart rejects malformed column.id from Graph response (defense-in-depth)', async () => {
    const graph = vi.fn().mockResolvedValueOnce({
      id: 'p1',
      canvasLayout: {
        horizontalSections: [{ id: 'sec1', columns: [{ id: 'col/../bad', webparts: [] }] }],
      },
    });
    const client = createMockClient(graph as unknown as Parameters<typeof createMockClient>[0]);
    const tools = createPageTools(client);
    const result = await tools
      .find((t) => t.tool.name === 'addWebPart')!
      .handler({
        pageId: 'p1',
        sectionIndex: 0,
        columnIndex: 0,
        innerHtml: '<p>x</p>',
      });
    expect(result.isError).toBe(true);
    expect((parseContent(result) as { code: string }).code).toBe('INVALID_ID');
  });

  it('rejects path-traversal pageId with INVALID_ID before any Graph call', async () => {
    const graph = vi.fn();
    const client = createMockClient(graph as unknown as Parameters<typeof createMockClient>[0]);
    const tools = createPageTools(client);
    const getPage = tools.find((t) => t.tool.name === 'getPage')!;
    const result = await getPage.handler({
      pageId: 'P1/../../drives/X/items',
    });
    expect(result.isError).toBe(true);
    const parsed = parseContent(result) as { code: string };
    expect(parsed.code).toBe('INVALID_ID');
    expect(graph).not.toHaveBeenCalled();
  });

  it('rejects query-injection pageId with INVALID_ID', async () => {
    const graph = vi.fn();
    const client = createMockClient(graph as unknown as Parameters<typeof createMockClient>[0]);
    const tools = createPageTools(client);
    const updatePage = tools.find((t) => t.tool.name === 'updatePage')!;
    const result = await updatePage.handler({
      pageId: '1?$select=secret',
      canvasLayout: { horizontalSections: [] },
    });
    expect(result.isError).toBe(true);
    expect(graph).not.toHaveBeenCalled();
  });

  it('rejects path-traversal webPartId with INVALID_ID', async () => {
    const graph = vi.fn();
    const client = createMockClient(graph as unknown as Parameters<typeof createMockClient>[0]);
    const tools = createPageTools(client);
    const removeWebPart = tools.find((t) => t.tool.name === 'removeWebPart')!;
    const result = await removeWebPart.handler({
      pageId: 'p1',
      webPartId: 'wp/../other',
    });
    expect(result.isError).toBe(true);
    const parsed = parseContent(result) as { code: string };
    expect(parsed.code).toBe('INVALID_ID');
    expect(graph).not.toHaveBeenCalled();
  });

  it('null client → NOT_CONFIGURED for every tool', async () => {
    const tools = createPageTools(null);
    for (const t of tools) {
      const result = await t.handler({
        pageId: 'p',
        title: 't',
        name: 'n',
        canvasLayout: { horizontalSections: [] },
        sectionIndex: 0,
        columnIndex: 0,
        innerHtml: '<p>x</p>',
        webPartId: 'wp',
      });
      expect(result.isError, `${t.tool.name} should error when client is null`).toBe(true);
      const parsed = parseContent(result) as { code: string };
      expect(parsed.code).toBe('NOT_CONFIGURED');
    }
  });

  it('generateTableOfContents injects id attributes on source headings and posts a ToC web part', async () => {
    const graph = vi
      .fn()
      // GET page
      .mockResolvedValueOnce({
        id: 'p1',
        canvasLayout: {
          horizontalSections: [
            {
              id: 'sec-id-1',
              columns: [
                {
                  id: 'col-id-1',
                  webparts: [{ id: 'wp1', innerHtml: '<h1>Intro</h1><h2>Setup</h2>' }],
                },
                {
                  id: 'col-id-2',
                  webparts: [{ id: 'wp2', innerHtml: '<h2>Outcome</h2>' }],
                },
              ],
            },
          ],
        },
      })
      // PATCH wp1 (inject ids), PATCH wp2 (inject id), POST ToC
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: 'wp-toc' });
    const client = createMockClient(graph as unknown as Parameters<typeof createMockClient>[0]);
    const tools = createPageTools(client);
    const toc = tools.find((t) => t.tool.name === 'generateTableOfContents')!;
    const out = parseContent(
      await toc.handler({
        pageId: 'p1',
        sectionIndex: 0,
        columnIndex: 0,
        title: 'Contents',
      })
    ) as { webPartId: string; headingCount: number; anchorsInjected: number };

    expect(out.webPartId).toBe('wp-toc');
    expect(out.headingCount).toBe(3);
    expect(out.anchorsInjected).toBe(2); // both source web parts got PATCHed

    // PATCH wp1 rewrites both h1 and h2 with id="…"
    const [m1, u1, b1] = graph.mock.calls[1];
    expect(m1).toBe('PATCH');
    expect(u1).toContain('/webParts/wp1');
    const wp1Html = (b1 as { webPartProperties: { data: { content: { formattedValue: string } } } })
      .webPartProperties.data.content.formattedValue;
    expect(wp1Html).toBe('<h1 id="intro">Intro</h1><h2 id="setup">Setup</h2>');

    // PATCH wp2 rewrites the single h2.
    const [m2, u2, b2] = graph.mock.calls[2];
    expect(m2).toBe('PATCH');
    expect(u2).toContain('/webParts/wp2');
    const wp2Html = (b2 as { webPartProperties: { data: { content: { formattedValue: string } } } })
      .webPartProperties.data.content.formattedValue;
    expect(wp2Html).toBe('<h2 id="outcome">Outcome</h2>');

    // POST ToC carries the rendered nested list.
    const [m3, , b3] = graph.mock.calls[3];
    expect(m3).toBe('POST');
    const tocHtml = (b3 as { webPartProperties: { data: { content: { formattedValue: string } } } })
      .webPartProperties.data.content.formattedValue;
    expect(tocHtml).toContain('<h2>Contents</h2>');
    expect(tocHtml).toContain('#intro');
    expect(tocHtml).toContain('#setup');
    expect(tocHtml).toContain('#outcome');
  });

  it('generateTableOfContents skips PATCH when all source headings already have ids', async () => {
    const graph = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'p1',
        canvasLayout: {
          horizontalSections: [
            {
              id: 'sec-id-1',
              columns: [
                {
                  id: 'col-id-1',
                  webparts: [{ id: 'wp1', innerHtml: '<h2 id="ready">Ready</h2>' }],
                },
              ],
            },
          ],
        },
      })
      .mockResolvedValueOnce({ id: 'wp-toc' });
    const client = createMockClient(graph as unknown as Parameters<typeof createMockClient>[0]);
    const tools = createPageTools(client);
    const toc = tools.find((t) => t.tool.name === 'generateTableOfContents')!;
    const out = parseContent(
      await toc.handler({ pageId: 'p1', sectionIndex: 0, columnIndex: 0 })
    ) as { headingCount: number; anchorsInjected: number };
    expect(out.headingCount).toBe(1);
    expect(out.anchorsInjected).toBe(0);
    // GET + POST only — no PATCH.
    expect(graph.mock.calls).toHaveLength(2);
  });

  it('generateTableOfContents errors NO_HEADINGS when the page has none', async () => {
    const graph = vi.fn().mockResolvedValueOnce({
      id: 'p1',
      canvasLayout: {
        horizontalSections: [{ id: 'sec-id-1', columns: [{ id: 'col-id-1', webparts: [] }] }],
      },
    });
    const client = createMockClient(graph as unknown as Parameters<typeof createMockClient>[0]);
    const tools = createPageTools(client);
    const toc = tools.find((t) => t.tool.name === 'generateTableOfContents')!;
    const result = await toc.handler({ pageId: 'p1', sectionIndex: 0, columnIndex: 0 });
    expect(result.isError).toBe(true);
    expect((parseContent(result) as { code: string }).code).toBe('NO_HEADINGS');
  });

  it('generateTableOfContents validates minLevel/maxLevel bounds', async () => {
    const graph = vi.fn();
    const client = createMockClient(graph as unknown as Parameters<typeof createMockClient>[0]);
    const tools = createPageTools(client);
    const toc = tools.find((t) => t.tool.name === 'generateTableOfContents')!;
    const result = await toc.handler({
      pageId: 'p1',
      sectionIndex: 0,
      columnIndex: 0,
      minLevel: 4,
      maxLevel: 2,
    });
    expect(result.isError).toBe(true);
    expect((parseContent(result) as { code: string }).code).toBe('INVALID_INPUT');
  });
});
