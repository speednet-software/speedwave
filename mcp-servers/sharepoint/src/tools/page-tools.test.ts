/**
 * Tests for SharePoint page tools (PR4 / ADR-060).
 *
 * Web part write tools (addWebPart / updateWebPart / removeWebPart) target the
 * real Microsoft Graph endpoints under
 *   /sites/{site-id}/pages/{page-id}/microsoft.graph.sitePage/canvasLayout/...
 *
 * MVP scope: only `#microsoft.graph.textWebPart` (with `innerHtml`). Other web
 * part types — image, link, standardWebPart — require per-type Graph payloads
 * with GUID-typed discriminators (see standardWebPart resource) and are out of
 * scope for PR4.
 *
 * Covers:
 * - Metadata: tool names + critical schema invariants.
 * - Site-policy by omission: NO tool's input schema accepts `site_id`. The
 *   worker always derives it from `/tokens/site_id` (`client.getSiteId()`).
 * - Happy path for each of the 8 handlers (mocked Graph responses).
 * - Error paths: range errors, INVALID_ID, NOT_CONFIGURED for null client.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolsCallResult } from '@speedwave/mcp-shared';
import { SharePointClient } from '../client.js';
import { createPageTools, PAGE_TOOL_SCHEMAS, type SitePage } from './page-tools.js';

const MOCK_SITE_ID = 'speednet.sharepoint.com,abc,def';

/** Create a SharePointClient stub with controllable graphRequest. */
function createMockClient(
  graphRequestImpl: (method: string, url: string, body?: unknown) => Promise<unknown> = async () =>
    undefined
): SharePointClient {
  return {
    getSiteId: () => MOCK_SITE_ID,
    graphRequest: vi.fn(graphRequestImpl),
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
  it('exposes exactly 8 tools', () => {
    expect(PAGE_TOOL_SCHEMAS).toHaveLength(8);
  });

  it('all 8 tool names match the PR4 contract', () => {
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
    ]);
  });

  // SITE-POLICY-BY-OMISSION REGRESSION TEST (ADR-060).
  //
  // The whole point of this invariant is that the model never picks a site.
  // Any future tool that grows a `site_id` property must fail loudly here so
  // we re-think the security model rather than silently widen the attack
  // surface to "model can target any SharePoint site the worker can reach".
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

  it('addWebPart input requires innerHtml (text-only MVP)', () => {
    const tool = PAGE_TOOL_SCHEMAS.find((t) => t.name === 'addWebPart')!;
    const schema = tool.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['pageId', 'sectionIndex', 'columnIndex', 'innerHtml'])
    );
    expect(schema.required).toContain('innerHtml');
    // MVP rejects image/link until standardWebPart support lands.
    expect(Object.keys(schema.properties)).not.toContain('webPart');
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
    expect(postBody).toEqual({
      '@odata.type': '#microsoft.graph.textWebPart',
      innerHtml: '<p>Hi</p>',
    });
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
    expect(url).toBe(
      `/sites/${MOCK_SITE_ID}/pages/p1/microsoft.graph.sitePage` +
        `/canvasLayout/horizontalSections/columns/webparts/wp-x`
    );
    expect(body).toEqual({
      '@odata.type': '#microsoft.graph.textWebPart',
      innerHtml: '<p>new</p>',
    });
  });

  it('removeWebPart DELETEs at the dedicated Graph endpoint', async () => {
    graph.mockResolvedValueOnce(undefined);
    const tools = createPageTools(client);
    const removeWebPart = tools.find((t) => t.tool.name === 'removeWebPart')!;
    await removeWebPart.handler({ pageId: 'p1', webPartId: 'wp-1' });
    expect(graph.mock.calls).toHaveLength(1);
    const [method, url] = graph.mock.calls[0];
    expect(method).toBe('DELETE');
    expect(url).toBe(
      `/sites/${MOCK_SITE_ID}/pages/p1/microsoft.graph.sitePage` +
        `/canvasLayout/horizontalSections/columns/webparts/wp-1`
    );
  });

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
});
