/**
 * Tests for SharePoint list / item / column / page-deletion tools (PR5).
 *
 * Covers:
 * - Metadata: tool names + critical schema invariants.
 * - Site-policy by omission: NO tool's input schema accepts `site_id`.
 * - Happy path for each handler (mocked graphRequest).
 * - Error paths via NOT_CONFIGURED + Graph rejections.
 * - Column type enum is exactly the 6 supported types.
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
