/**
 * Tests for SharePoint list / item / column / page-deletion tools (PR5).
 * Metadata, site-policy-by-omission (no site_id), happy/error paths, column type enum.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolsCallResult } from '@speedwave/mcp-shared';
import { SharePointClient } from '../client.js';
import { createListTools, LIST_TOOL_SCHEMAS } from './list-tools.js';

const MOCK_SITE_ID = 'speednet.sharepoint.com,abc,def';

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

describe('list-tools metadata', () => {
  it('exposes exactly 13 tools', () => {
    expect(LIST_TOOL_SCHEMAS).toHaveLength(13);
  });

  it('all 13 tool names match the PR5 contract', () => {
    const names = LIST_TOOL_SCHEMAS.map((t) => t.name);
    expect(names).toEqual([
      'listLists',
      'getList',
      'createList',
      'updateList',
      'deleteList',
      'addListColumn',
      'removeListColumn',
      'listItems',
      'getItem',
      'createItem',
      'updateItem',
      'deleteItem',
      'deletePage',
    ]);
  });

  // SITE-POLICY-BY-OMISSION REGRESSION (ADR-060). Same invariant as page tools.
  it('NO list tool accepts site_id from the model', () => {
    for (const tool of LIST_TOOL_SCHEMAS) {
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

  it('all destructive tools have destructiveHint annotation', () => {
    const destructive = new Set(['deleteList', 'removeListColumn', 'deleteItem', 'deletePage']);
    for (const tool of LIST_TOOL_SCHEMAS) {
      if (destructive.has(tool.name)) {
        expect(tool.annotations?.destructiveHint, `${tool.name} should be destructive`).toBe(true);
      }
    }
  });

  it('addListColumn restricts type to documented Graph column types', () => {
    const tool = LIST_TOOL_SCHEMAS.find((t) => t.name === 'addListColumn')!;
    const schema = tool.inputSchema as unknown as {
      properties: { type: { enum: string[] } };
    };
    expect(schema.properties.type.enum).toEqual([
      'text',
      'number',
      'boolean',
      'dateTime',
      'choice',
      'lookup',
    ]);
  });
});

describe('list-tools handlers — happy paths', () => {
  let graph: ReturnType<typeof vi.fn>;
  let client: SharePointClient;

  beforeEach(() => {
    graph = vi.fn();
    client = createMockClient(graph as unknown as Parameters<typeof createMockClient>[0]);
  });

  it('listLists projects the response', async () => {
    graph.mockResolvedValueOnce({
      value: [
        { id: 'L1', displayName: 'Tasks', webUrl: 'https://s/Tasks' },
        { id: 'L2', displayName: 'Docs', webUrl: 'https://s/Docs' },
      ],
    });
    const tools = createListTools(client);
    const out = parseContent(await tools.find((t) => t.tool.name === 'listLists')!.handler({})) as {
      lists: Array<{ id: string }>;
    };
    expect(out.lists).toHaveLength(2);
    expect(graph).toHaveBeenCalledWith('GET', `/sites/${MOCK_SITE_ID}/lists`);
  });

  it('getList expands columns', async () => {
    graph.mockResolvedValueOnce({ id: 'L1', columns: [{ id: 'C1', name: 'Title' }] });
    const tools = createListTools(client);
    const out = parseContent(
      await tools.find((t) => t.tool.name === 'getList')!.handler({ listId: 'L1' })
    ) as { list: { columns: unknown[] } };
    expect(out.list.columns).toHaveLength(1);
    expect(graph.mock.calls[0][1]).toContain('$expand=columns');
  });

  it('createList POSTs with displayName and default template', async () => {
    graph.mockResolvedValueOnce({ id: 'L-new', webUrl: 'https://s/L-new' });
    const tools = createListTools(client);
    const out = parseContent(
      await tools.find((t) => t.tool.name === 'createList')!.handler({ displayName: 'Tasks' })
    ) as { listId: string; webUrl: string };
    expect(out.listId).toBe('L-new');
    const [method, url, body] = graph.mock.calls[0];
    expect(method).toBe('POST');
    expect(url).toBe(`/sites/${MOCK_SITE_ID}/lists`);
    expect(body).toMatchObject({
      displayName: 'Tasks',
      list: { template: 'genericList' },
    });
  });

  it('createList returns empty strings (not undefined) when Graph response omits id/webUrl', async () => {
    // Contract: always return a {listId, webUrl} pair; empty string is the
    // fallback when Graph omits them (e.g. 204).
    graph.mockResolvedValueOnce(undefined);
    const tools = createListTools(client);
    const out = parseContent(
      await tools.find((t) => t.tool.name === 'createList')!.handler({ displayName: 'Tasks' })
    ) as { listId: string; webUrl: string };
    expect(out).toEqual({ listId: '', webUrl: '' });
  });

  it('updateList PATCHes only the fields provided', async () => {
    graph.mockResolvedValueOnce(undefined);
    const tools = createListTools(client);
    await tools
      .find((t) => t.tool.name === 'updateList')!
      .handler({ listId: 'L1', displayName: 'Renamed' });
    const [, , body] = graph.mock.calls[0];
    expect(body).toEqual({ displayName: 'Renamed' });
  });

  it('deleteList DELETEs the list', async () => {
    graph.mockResolvedValueOnce(undefined);
    const tools = createListTools(client);
    await tools.find((t) => t.tool.name === 'deleteList')!.handler({ listId: 'L1' });
    expect(graph).toHaveBeenCalledWith('DELETE', `/sites/${MOCK_SITE_ID}/lists/L1`);
  });

  it('addListColumn builds type-specific payload for choice', async () => {
    graph.mockResolvedValueOnce({ id: 'C-new' });
    const tools = createListTools(client);
    const out = parseContent(
      await tools
        .find((t) => t.tool.name === 'addListColumn')!
        .handler({
          listId: 'L1',
          name: 'Status',
          type: 'choice',
          choices: ['Open', 'Closed'],
        })
    ) as { columnId: string };
    expect(out.columnId).toBe('C-new');
    const [, , body] = graph.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(body.name).toBe('Status');
    expect(body.choice).toEqual({ choices: ['Open', 'Closed'], displayAs: 'dropDownMenu' });
    expect(body.text).toBeUndefined();
  });

  it('addListColumn builds lookup payload', async () => {
    graph.mockResolvedValueOnce({ id: 'C-l' });
    const tools = createListTools(client);
    await tools
      .find((t) => t.tool.name === 'addListColumn')!
      .handler({
        listId: 'L1',
        name: 'OwnerLookup',
        type: 'lookup',
        lookupListId: 'L9',
        lookupColumnName: 'Title',
      });
    const [, , body] = graph.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(body.lookup).toEqual({ listId: 'L9', columnName: 'Title' });
  });

  it('addListColumn falls back to defaults for text type', async () => {
    graph.mockResolvedValueOnce({ id: 'C-t' });
    const tools = createListTools(client);
    await tools
      .find((t) => t.tool.name === 'addListColumn')!
      .handler({
        listId: 'L1',
        name: 'Title',
        type: 'text',
      });
    const [, , body] = graph.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(body.text).toEqual({});
    expect(body.displayName).toBe('Title'); // default to `name`
  });

  it.each([
    ['number', 'number'],
    ['boolean', 'boolean'],
    ['dateTime', 'dateTime'],
  ] as const)('addListColumn builds %s payload', async (type, bodyKey) => {
    graph.mockResolvedValueOnce({ id: 'C-x' });
    const tools = createListTools(client);
    await tools
      .find((t) => t.tool.name === 'addListColumn')!
      .handler({ listId: 'L1', name: 'F', type });
    const [, , body] = graph.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(body[bodyKey]).toEqual({});
  });

  it('addListColumn returns empty columnId when Graph response omits id', async () => {
    // Contract: always return a {columnId} key; empty string when Graph omits
    // the id (e.g. 204 / async create).
    graph.mockResolvedValueOnce(undefined);
    const tools = createListTools(client);
    const out = parseContent(
      await tools
        .find((t) => t.tool.name === 'addListColumn')!
        .handler({ listId: 'L1', name: 'Title', type: 'text' })
    ) as { columnId: string };
    expect(out).toEqual({ columnId: '' });
  });

  it('removeListColumn DELETEs the column', async () => {
    graph.mockResolvedValueOnce(undefined);
    const tools = createListTools(client);
    await tools
      .find((t) => t.tool.name === 'removeListColumn')!
      .handler({ listId: 'L1', columnId: 'C1' });
    expect(graph).toHaveBeenCalledWith('DELETE', `/sites/${MOCK_SITE_ID}/lists/L1/columns/C1`);
  });

  it('listItems builds the URL with $expand=fields', async () => {
    graph.mockResolvedValueOnce({
      value: [
        { id: '1', fields: { Title: 'A' } },
        { id: '2', fields: { Title: 'B' } },
      ],
    });
    const tools = createListTools(client);
    const out = parseContent(
      await tools.find((t) => t.tool.name === 'listItems')!.handler({ listId: 'L1' })
    ) as { items: Array<{ id: string }> };
    expect(out.items).toHaveLength(2);
    expect(graph.mock.calls[0][1]).toContain('$expand=fields');
  });

  it('listItems returns an empty items array when Graph response omits value', async () => {
    // Contract: stable {items: []} shape when Graph omits value (e.g. {} or null).
    graph.mockResolvedValueOnce(undefined);
    const tools = createListTools(client);
    const out = parseContent(
      await tools.find((t) => t.tool.name === 'listItems')!.handler({ listId: 'L1' })
    ) as { items: unknown[] };
    expect(out).toEqual({ items: [] });
  });

  it('listItems appends $filter and $top when provided', async () => {
    graph.mockResolvedValueOnce({ value: [] });
    const tools = createListTools(client);
    await tools
      .find((t) => t.tool.name === 'listItems')!
      .handler({ listId: 'L1', filter: "fields/Status eq 'Open'", top: 5 });
    const url = graph.mock.calls[0][1] as string;
    expect(url).toContain('$filter=');
    expect(url).toContain('$top=5');
  });

  it('getItem fetches one item with fields', async () => {
    graph.mockResolvedValueOnce({ id: '1', fields: { Title: 'A' } });
    const tools = createListTools(client);
    const out = parseContent(
      await tools.find((t) => t.tool.name === 'getItem')!.handler({ listId: 'L1', itemId: '1' })
    ) as { item: { id: string } };
    expect(out.item.id).toBe('1');
    expect(graph.mock.calls[0][1]).toContain('$expand=fields');
  });

  it('createItem POSTs { fields }', async () => {
    graph.mockResolvedValueOnce({ id: '42' });
    const tools = createListTools(client);
    const out = parseContent(
      await tools
        .find((t) => t.tool.name === 'createItem')!
        .handler({ listId: 'L1', fields: { Title: 'New' } })
    ) as { itemId: string };
    expect(out.itemId).toBe('42');
    const [method, , body] = graph.mock.calls[0];
    expect(method).toBe('POST');
    expect(body).toEqual({ fields: { Title: 'New' } });
  });

  it('createItem returns empty itemId when Graph response omits id', async () => {
    // Stable {itemId} contract — empty string for non-echoing Graph paths.
    graph.mockResolvedValueOnce(undefined);
    const tools = createListTools(client);
    const out = parseContent(
      await tools
        .find((t) => t.tool.name === 'createItem')!
        .handler({ listId: 'L1', fields: { Title: 'New' } })
    ) as { itemId: string };
    expect(out).toEqual({ itemId: '' });
  });

  it('updateItem PATCHes /fields with the field map directly', async () => {
    graph.mockResolvedValueOnce(undefined);
    const tools = createListTools(client);
    await tools
      .find((t) => t.tool.name === 'updateItem')!
      .handler({ listId: 'L1', itemId: '1', fields: { Status: 'Done' } });
    const [method, url, body] = graph.mock.calls[0];
    expect(method).toBe('PATCH');
    expect(url).toBe(`/sites/${MOCK_SITE_ID}/lists/L1/items/1/fields`);
    expect(body).toEqual({ Status: 'Done' });
  });

  it('deleteItem DELETEs the item', async () => {
    graph.mockResolvedValueOnce(undefined);
    const tools = createListTools(client);
    await tools.find((t) => t.tool.name === 'deleteItem')!.handler({ listId: 'L1', itemId: '1' });
    expect(graph).toHaveBeenCalledWith('DELETE', `/sites/${MOCK_SITE_ID}/lists/L1/items/1`);
  });

  it('deletePage DELETEs the page', async () => {
    graph.mockResolvedValueOnce(undefined);
    const tools = createListTools(client);
    await tools.find((t) => t.tool.name === 'deletePage')!.handler({ pageId: 'P1' });
    expect(graph).toHaveBeenCalledWith('DELETE', `/sites/${MOCK_SITE_ID}/pages/P1`);
  });

  it('createList accepts initial columns and template', async () => {
    graph.mockResolvedValueOnce({ id: 'L-x' });
    const tools = createListTools(client);
    await tools
      .find((t) => t.tool.name === 'createList')!
      .handler({
        displayName: 'Custom',
        template: 'documentLibrary',
        columns: [{ id: 'c', name: 'Title' }],
      });
    const [, , body] = graph.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(body.list).toEqual({ template: 'documentLibrary' });
    expect(body.columns).toHaveLength(1);
  });
});

describe('list-tools handlers — error paths', () => {
  it('listLists surfaces Graph errors with LIST_LISTS_FAILED', async () => {
    const graph = vi.fn().mockRejectedValueOnce(new Error('Graph 500'));
    const client = createMockClient(graph as unknown as Parameters<typeof createMockClient>[0]);
    const tools = createListTools(client);
    const result = await tools.find((t) => t.tool.name === 'listLists')!.handler({});
    expect(result.isError).toBe(true);
    const parsed = parseContent(result) as { code: string };
    expect(parsed.code).toBe('LIST_LISTS_FAILED');
  });

  // One table-driven case per handler's XXX_FAILED code (each wrapErr path).
  it.each([
    ['getList', { listId: 'L1' }, 'GET_LIST_FAILED'],
    ['createList', { displayName: 'X', description: 'd', template: 't' }, 'CREATE_LIST_FAILED'],
    ['updateList', { listId: 'L1', displayName: 'R' }, 'UPDATE_LIST_FAILED'],
    ['deleteList', { listId: 'L1' }, 'DELETE_LIST_FAILED'],
    ['addListColumn', { listId: 'L1', name: 'F', type: 'text' as const }, 'ADD_LIST_COLUMN_FAILED'],
    ['removeListColumn', { listId: 'L1', columnId: 'C1' }, 'REMOVE_LIST_COLUMN_FAILED'],
    ['listItems', { listId: 'L1' }, 'LIST_ITEMS_FAILED'],
    ['getItem', { listId: 'L1', itemId: '1' }, 'GET_ITEM_FAILED'],
    ['createItem', { listId: 'L1', fields: { Title: 'X' } }, 'CREATE_ITEM_FAILED'],
    ['updateItem', { listId: 'L1', itemId: '1', fields: { Title: 'X' } }, 'UPDATE_ITEM_FAILED'],
    ['deleteItem', { listId: 'L1', itemId: '1' }, 'DELETE_ITEM_FAILED'],
    ['deletePage', { pageId: 'P1' }, 'DELETE_PAGE_FAILED'],
  ] as const)('%s surfaces Graph errors with %s', async (toolName, params, code) => {
    const graph = vi.fn().mockRejectedValueOnce(new Error('Graph 500'));
    const client = createMockClient(graph as unknown as Parameters<typeof createMockClient>[0]);
    const tools = createListTools(client);
    const result = await tools.find((t) => t.tool.name === toolName)!.handler(params);
    expect(result.isError).toBe(true);
    expect((parseContent(result) as { code: string }).code).toBe(code);
  });

  it('listItems appends a single-quote hint when filter contains a double quote', async () => {
    const graph = vi.fn().mockRejectedValueOnce(new Error('400 Bad Request'));
    const client = createMockClient(graph as unknown as Parameters<typeof createMockClient>[0]);
    const tools = createListTools(client);
    const result = await tools
      .find((t) => t.tool.name === 'listItems')!
      .handler({ listId: 'L1', filter: 'fields/Status eq "Open"' });
    expect(result.isError).toBe(true);
    const parsed = parseContent(result) as { code: string; message: string };
    expect(parsed.code).toBe('LIST_ITEMS_FAILED');
    expect(parsed.message).toContain('single-quoted string literals');
  });

  it('listItems does not append the quote hint when filter has no double quote', async () => {
    const graph = vi.fn().mockRejectedValueOnce(new Error('400 Bad Request'));
    const client = createMockClient(graph as unknown as Parameters<typeof createMockClient>[0]);
    const tools = createListTools(client);
    const result = await tools
      .find((t) => t.tool.name === 'listItems')!
      .handler({ listId: 'L1', filter: "fields/Status eq 'Open'" });
    const parsed = parseContent(result) as { message: string };
    expect(parsed.message).not.toContain('single-quoted string literals');
  });

  it('updateList errors when description is provided alone', async () => {
    // Covers the description-only branch (displayName omitted).
    const graph = vi.fn().mockResolvedValueOnce(undefined);
    const client = createMockClient(graph as unknown as Parameters<typeof createMockClient>[0]);
    const tools = createListTools(client);
    await tools
      .find((t) => t.tool.name === 'updateList')!
      .handler({ listId: 'L1', description: 'new desc' });
    const [, , body] = graph.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(body).toEqual({ description: 'new desc' });
  });

  it('createList omits description when not provided', async () => {
    // Covers the `if (params.description) body.description = …` falsy branch.
    const graph = vi.fn().mockResolvedValueOnce({ id: 'L-new' });
    const client = createMockClient(graph as unknown as Parameters<typeof createMockClient>[0]);
    const tools = createListTools(client);
    await tools.find((t) => t.tool.name === 'createList')!.handler({ displayName: 'X' });
    const [, , body] = graph.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(body).not.toHaveProperty('description');
  });

  // Per-tool listId / itemId / columnId validateGraphId rejections.
  it.each([
    ['getList', { listId: 'bad/../path' }],
    ['updateList', { listId: 'bad/../path', displayName: 'X' }],
    ['deleteList', { listId: 'bad/../path' }],
    ['addListColumn', { listId: 'bad/../path', name: 'F', type: 'text' as const }],
    [
      'addListColumn',
      {
        listId: 'L1',
        name: 'F',
        type: 'lookup' as const,
        lookupListId: 'bad/../path',
        lookupColumnName: 'Title',
      },
    ],
    ['removeListColumn', { listId: 'bad/../path', columnId: 'C1' }],
    ['removeListColumn', { listId: 'L1', columnId: 'bad/../path' }],
    ['listItems', { listId: 'bad/../path' }],
    ['getItem', { listId: 'bad/../path', itemId: '1' }],
    ['getItem', { listId: 'L1', itemId: 'bad/../path' }],
    ['createItem', { listId: 'bad/../path', fields: {} }],
    ['updateItem', { listId: 'bad/../path', itemId: '1', fields: {} }],
    ['deleteItem', { listId: 'bad/../path', itemId: '1' }],
    ['deleteItem', { listId: 'L1', itemId: 'bad/../path' }],
    ['deletePage', { pageId: 'bad/../path' }],
  ] as const)('%s rejects malformed id with INVALID_ID', async (toolName, params) => {
    const graph = vi.fn();
    const client = createMockClient(graph as unknown as Parameters<typeof createMockClient>[0]);
    const tools = createListTools(client);
    const result = await tools.find((t) => t.tool.name === toolName)!.handler(params);
    expect(result.isError).toBe(true);
    expect((parseContent(result) as { code: string }).code).toBe('INVALID_ID');
    expect(graph).not.toHaveBeenCalled();
  });

  it('listItems passes through optional filter and top', async () => {
    // Covers the filter and top branches in handleListItems.
    const graph = vi.fn().mockResolvedValueOnce({ value: [] });
    const client = createMockClient(graph as unknown as Parameters<typeof createMockClient>[0]);
    const tools = createListTools(client);
    await tools
      .find((t) => t.tool.name === 'listItems')!
      .handler({ listId: 'L1', filter: "fields/Title eq 'X'", top: 25 });
    const [, url] = graph.mock.calls[0];
    expect(url).toContain('$filter=');
    expect(url).toContain('$top=25');
    expect(url).toContain('$expand=fields');
  });

  it('rejects path-traversal listId with INVALID_ID before any Graph call', async () => {
    const graph = vi.fn();
    const client = createMockClient(graph as unknown as Parameters<typeof createMockClient>[0]);
    const tools = createListTools(client);
    const getList = tools.find((t) => t.tool.name === 'getList')!;
    const result = await getList.handler({ listId: 'L1/../../drives' });
    expect(result.isError).toBe(true);
    const parsed = parseContent(result) as { code: string };
    expect(parsed.code).toBe('INVALID_ID');
    expect(graph).not.toHaveBeenCalled();
  });

  it('rejects query-injection itemId with INVALID_ID', async () => {
    const graph = vi.fn();
    const client = createMockClient(graph as unknown as Parameters<typeof createMockClient>[0]);
    const tools = createListTools(client);
    const updateItem = tools.find((t) => t.tool.name === 'updateItem')!;
    const result = await updateItem.handler({
      listId: 'L1',
      itemId: '1?$expand=...',
      fields: { Title: 'X' },
    });
    expect(result.isError).toBe(true);
    expect(graph).not.toHaveBeenCalled();
  });

  it('null client → NOT_CONFIGURED for every tool', async () => {
    const tools = createListTools(null);
    for (const t of tools) {
      const result = await t.handler({
        listId: 'L1',
        itemId: '1',
        columnId: 'C1',
        displayName: 'x',
        name: 'x',
        type: 'text',
        fields: {},
        pageId: 'P1',
      });
      expect(result.isError, `${t.tool.name} should error when client is null`).toBe(true);
      const parsed = parseContent(result) as { code: string };
      expect(parsed.code).toBe('NOT_CONFIGURED');
    }
  });
});
