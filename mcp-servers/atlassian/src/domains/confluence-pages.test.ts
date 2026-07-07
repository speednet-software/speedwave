/**
 * Tests for the Confluence pages domain client (CQL search v1, page CRUD v2,
 * automatic version bump on update, space-key scope enforcement).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createConfluencePagesClient } from './confluence-pages.js';
import { ScopeError } from '../scope.js';
import type { AtlassianClient } from '../client.js';

function stubClient(spaceKeys: string[] = []) {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    del: vi.fn(),
    jiraProjectKeys: [] as string[],
    confluenceSpaceKeys: spaceKeys,
  } as unknown as AtlassianClient & {
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
  };
}

const v2Page = (over: Record<string, unknown> = {}) => ({
  id: '123',
  status: 'current',
  title: 'My Page',
  spaceId: '900',
  parentId: '100',
  version: { number: 3 },
  body: { storage: { value: '<p>hi</p>' } },
  _links: { webui: '/wiki/spaces/DEV/pages/123' },
  ...over,
});

let client: ReturnType<typeof stubClient>;
beforeEach(() => {
  client = stubClient();
});

describe('search (CQL via v1)', () => {
  it('GETs /wiki/rest/api/content/search, caps limit, maps page results', async () => {
    client.get.mockResolvedValueOnce({
      results: [
        {
          id: '1',
          type: 'page',
          title: 'P',
          space: { id: '900', key: 'DEV' },
          version: { number: 2 },
          _links: { webui: '/x' },
        },
        { id: '2', type: 'blogpost', title: 'B' },
      ],
    });
    const c = createConfluencePagesClient(client);
    const res = await c.search({ cql: 'type=page', limit: 999 });
    expect(client.get).toHaveBeenCalledWith('/wiki/rest/api/content/search', {
      cql: 'type=page',
      limit: 100,
    });
    expect(res).toHaveLength(1);
    // v1 search results carry no usable version detail → null ("unknown").
    expect(res[0]).toMatchObject({ id: '1', title: 'P', space_key: 'DEV', version: null });
  });

  it('drops pages outside the space allowlist', async () => {
    client = stubClient(['DEV']);
    client.get.mockResolvedValueOnce({
      results: [
        { id: '1', type: 'page', title: 'A', space: { key: 'DEV' } },
        { id: '2', type: 'page', title: 'B', space: { key: 'OPS' } },
        { id: '3', type: 'page', title: 'C' }, // no space → dropped when allowlist set
      ],
    });
    const c = createConfluencePagesClient(client);
    expect((await c.search({ cql: 'x' })).map((p) => p.id)).toEqual(['1']);
  });

  it('handles a missing results array', async () => {
    client.get.mockResolvedValueOnce({});
    const c = createConfluencePagesClient(client);
    expect(await c.search({ cql: 'x' })).toEqual([]);
  });
});

describe('get', () => {
  it('fetches a page (v2), resolves the space key, enforces the allowlist', async () => {
    client.get
      .mockResolvedValueOnce(v2Page()) // page
      .mockResolvedValueOnce({ key: 'DEV' }); // space lookup
    const c = createConfluencePagesClient(client);
    const page = await c.get('123', { includeBody: true });
    expect(client.get).toHaveBeenNthCalledWith(1, '/wiki/api/v2/pages/123', {
      'body-format': 'storage',
    });
    expect(client.get).toHaveBeenNthCalledWith(2, '/wiki/api/v2/spaces/900');
    expect(page).toMatchObject({
      id: '123',
      title: 'My Page',
      version: 3,
      space_key: 'DEV',
      body_storage: '<p>hi</p>',
    });
  });

  it('omits body-format when includeBody is falsy', async () => {
    client.get.mockResolvedValueOnce(v2Page()).mockResolvedValueOnce({ key: 'DEV' });
    const c = createConfluencePagesClient(client);
    await c.get('123');
    expect(client.get).toHaveBeenNthCalledWith(1, '/wiki/api/v2/pages/123', {});
  });

  it('tolerates a 404 space lookup (space_key undefined) when no allowlist', async () => {
    const notFound = Object.assign(new Error('not found'), { response: { status: 404 } });
    client.get.mockResolvedValueOnce(v2Page()).mockRejectedValueOnce(notFound);
    const c = createConfluencePagesClient(client);
    expect((await c.get('123')).space_key).toBeUndefined();
  });

  it('rethrows a non-404 space lookup failure instead of conflating it with scope denial', async () => {
    client.get.mockResolvedValueOnce(v2Page()).mockRejectedValueOnce(new Error('ETIMEDOUT'));
    const c = createConfluencePagesClient(client);
    await expect(c.get('123')).rejects.toThrow(/space lookup failed/i);
  });

  it('rejects a page outside the space allowlist', async () => {
    client = stubClient(['DEV']);
    client.get.mockResolvedValueOnce(v2Page()).mockResolvedValueOnce({ key: 'OPS' });
    const c = createConfluencePagesClient(client);
    await expect(c.get('123')).rejects.toThrow(ScopeError);
  });
});

describe('getByTitle', () => {
  it('resolves the space id, queries by exact title, returns the first match', async () => {
    client.get
      .mockResolvedValueOnce({ results: [{ id: '900', key: 'DEV' }] }) // resolveSpaceId
      .mockResolvedValueOnce({ results: [v2Page()] }); // pages by title
    const c = createConfluencePagesClient(client);
    const page = await c.getByTitle('DEV', 'My Page', { includeBody: true });
    expect(client.get).toHaveBeenNthCalledWith(1, '/wiki/api/v2/spaces', { keys: 'DEV', limit: 1 });
    expect(client.get).toHaveBeenNthCalledWith(2, '/wiki/api/v2/pages', {
      'space-id': '900',
      title: 'My Page',
      limit: 1,
      'body-format': 'storage',
    });
    // space_key resolved from the cache populated by resolveSpaceId — no extra GET.
    expect(page).toMatchObject({ id: '123', space_key: 'DEV' });
  });

  it('throws when the space is not found', async () => {
    client.get.mockResolvedValueOnce({ results: [] });
    const c = createConfluencePagesClient(client);
    await expect(c.getByTitle('NOPE', 'x')).rejects.toThrow(/not found/i);
  });

  it('throws when the page title is not found', async () => {
    client.get
      .mockResolvedValueOnce({ results: [{ id: '900', key: 'DEV' }] })
      .mockResolvedValueOnce({ results: [] });
    const c = createConfluencePagesClient(client);
    await expect(c.getByTitle('DEV', 'Ghost')).rejects.toThrow(/not found/i);
  });

  it('rejects up front when the space is outside the allowlist', async () => {
    client = stubClient(['DEV']);
    const c = createConfluencePagesClient(client);
    await expect(c.getByTitle('OPS', 'x')).rejects.toThrow(ScopeError);
    expect(client.get).not.toHaveBeenCalled();
  });
});

describe('create', () => {
  it('resolves the space id and POSTs a storage body (plain text wrapped)', async () => {
    client.get.mockResolvedValueOnce({ results: [{ id: '900', key: 'DEV' }] });
    client.post.mockResolvedValueOnce(v2Page());
    const c = createConfluencePagesClient(client);
    const page = await c.create({
      spaceKey: 'DEV',
      title: 'New',
      body: { text: 'a & b' },
      parentId: '100',
    });
    const sent = client.post.mock.calls[0];
    expect(sent[0]).toBe('/wiki/api/v2/pages');
    expect(sent[1]).toMatchObject({
      spaceId: '900',
      status: 'current',
      title: 'New',
      parentId: '100',
      body: { representation: 'storage', value: '<p>a &amp; b</p>' },
    });
    expect(page.id).toBe('123');
  });

  it('passes a raw storage body through and omits parentId when not given', async () => {
    client.get.mockResolvedValueOnce({ results: [{ id: '900', key: 'DEV' }] });
    client.post.mockResolvedValueOnce(v2Page());
    const c = createConfluencePagesClient(client);
    await c.create({ spaceKey: 'DEV', title: 'New', body: { storage: '<h1>raw</h1>' } });
    const sent = client.post.mock.calls[0][1] as { body: { value: string }; parentId?: string };
    expect(sent.body.value).toBe('<h1>raw</h1>');
    expect(sent.parentId).toBeUndefined();
  });

  it('rejects creation outside the space allowlist', async () => {
    client = stubClient(['DEV']);
    const c = createConfluencePagesClient(client);
    await expect(c.create({ spaceKey: 'OPS', title: 'x', body: { text: 'x' } })).rejects.toThrow(
      ScopeError
    );
  });
});

describe('update', () => {
  it('fetches the current page, increments the version, and PUTs', async () => {
    client.get
      .mockResolvedValueOnce(v2Page()) // current page (version 3)
      .mockResolvedValueOnce({ key: 'DEV' }); // resolveSpaceKey
    client.put.mockResolvedValueOnce(v2Page({ version: { number: 4 } }));
    const c = createConfluencePagesClient(client);
    const page = await c.update('123', { title: 'Renamed', body: { storage: '<p>new</p>' } });
    const sent = client.put.mock.calls[0];
    expect(sent[0]).toBe('/wiki/api/v2/pages/123');
    expect(sent[1]).toMatchObject({
      id: '123',
      status: 'current',
      title: 'Renamed',
      version: { number: 4 },
      body: { representation: 'storage', value: '<p>new</p>' },
    });
    expect(page.version).toBe(4);
  });

  it('wraps a plain-text body before PUTting', async () => {
    client.get.mockResolvedValueOnce(v2Page()).mockResolvedValueOnce({ key: 'DEV' });
    client.put.mockResolvedValueOnce(v2Page({ version: { number: 4 } }));
    const c = createConfluencePagesClient(client);
    await c.update('123', { body: { text: 'a & b' } });
    const sent = client.put.mock.calls[0][1] as { body: { representation: string; value: string } };
    expect(sent.body).toEqual({ representation: 'storage', value: '<p>a &amp; b</p>' });
  });

  it('keeps the existing title and omits body when not provided', async () => {
    client.get.mockResolvedValueOnce(v2Page()).mockResolvedValueOnce({ key: 'DEV' });
    client.put.mockResolvedValueOnce(v2Page({ version: { number: 4 } }));
    const c = createConfluencePagesClient(client);
    await c.update('123', {});
    const sent = client.put.mock.calls[0][1] as { title: string; body?: unknown };
    expect(sent.title).toBe('My Page');
    expect(sent.body).toBeUndefined();
  });

  it('rejects updating a page outside the space allowlist', async () => {
    client = stubClient(['DEV']);
    client.get.mockResolvedValueOnce(v2Page()).mockResolvedValueOnce({ key: 'OPS' });
    const c = createConfluencePagesClient(client);
    await expect(c.update('123', { title: 'x' })).rejects.toThrow(ScopeError);
    expect(client.put).not.toHaveBeenCalled();
  });

  it('primes the space-key cache so a following get() needs no extra space GET', async () => {
    // update(): page GET + space GET (primes cache) + PUT.
    client.get.mockResolvedValueOnce(v2Page()).mockResolvedValueOnce({ key: 'DEV' });
    client.put.mockResolvedValueOnce(v2Page({ version: { number: 4 } }));
    // get(): page GET only — space key for spaceId 900 is already cached.
    client.get.mockResolvedValueOnce(v2Page());
    const c = createConfluencePagesClient(client);
    await c.update('123', { title: 'x' });
    await c.get('123');
    // 3 GETs (update's page + update's space + get's page), not 4.
    expect(client.get).toHaveBeenCalledTimes(3);
  });
});

describe('getChildren', () => {
  it('lists direct children (best-effort mapping), capping limit', async () => {
    client.get.mockResolvedValueOnce({
      results: [{ id: '124', status: 'current', title: 'Child', parentId: '123' }],
    });
    const c = createConfluencePagesClient(client);
    const res = await c.getChildren('123', { limit: 999 });
    expect(client.get).toHaveBeenCalledWith('/wiki/api/v2/pages/123/children', { limit: 100 });
    expect(res[0]).toMatchObject({
      id: '124',
      title: 'Child',
      parent_id: '123',
      space_id: '',
      version: null,
    });
  });

  it('does not resolve the page space when no allowlist is configured (single GET)', async () => {
    client.get.mockResolvedValueOnce({ results: [] });
    const c = createConfluencePagesClient(client);
    await c.getChildren('123');
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  it('enforces the space allowlist before listing children', async () => {
    client = stubClient(['DEV']);
    client.get
      .mockResolvedValueOnce(v2Page()) // page lookup for enforcement
      .mockResolvedValueOnce({ key: 'OPS' }); // space lookup → outside allowlist
    const c = createConfluencePagesClient(client);
    await expect(c.getChildren('123')).rejects.toThrow(ScopeError);
  });

  it('lists children when the page space is in the allowlist', async () => {
    client = stubClient(['DEV']);
    client.get
      .mockResolvedValueOnce(v2Page()) // page lookup
      .mockResolvedValueOnce({ key: 'DEV' }) // space lookup → allowed
      .mockResolvedValueOnce({ results: [{ id: '124', status: 'current', title: 'Child' }] });
    const c = createConfluencePagesClient(client);
    expect((await c.getChildren('123'))[0]).toMatchObject({ id: '124', title: 'Child' });
  });

  it('handles a missing results array and default limit', async () => {
    client.get.mockResolvedValueOnce({});
    const c = createConfluencePagesClient(client);
    expect(await c.getChildren('123')).toEqual([]);
    expect(client.get).toHaveBeenCalledWith('/wiki/api/v2/pages/123/children', { limit: 25 });
  });
});

describe('normalisation edge cases', () => {
  it('handles a v2 page with no body/version/links', async () => {
    client.get
      .mockResolvedValueOnce({ id: '9', title: 'T', spaceId: '900' })
      .mockResolvedValueOnce({ key: 'DEV' });
    const c = createConfluencePagesClient(client);
    const page = await c.get('9');
    expect(page).toMatchObject({ id: '9', status: 'current', version: 1, parent_id: null });
    expect(page.body_storage).toBeUndefined();
    expect(page.web_url).toBeUndefined();
  });

  it('caches a resolved space key across calls (no second space GET)', async () => {
    client.get
      .mockResolvedValueOnce(v2Page()) // get #1 page
      .mockResolvedValueOnce({ key: 'DEV' }) // get #1 space
      .mockResolvedValueOnce(v2Page()); // get #2 page (no space GET → cache hit)
    const c = createConfluencePagesClient(client);
    await c.get('123');
    await c.get('123');
    expect(client.get).toHaveBeenCalledTimes(3);
  });

  it('handles an empty spaceId (no space lookup)', async () => {
    client.get.mockResolvedValueOnce({ id: '9', title: 'T', spaceId: '' });
    const c = createConfluencePagesClient(client);
    expect((await c.get('9')).space_key).toBeUndefined();
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  it('mapV2Page handles a page with no id/parent/links', async () => {
    client.get.mockResolvedValueOnce({}).mockResolvedValueOnce({});
    const c = createConfluencePagesClient(client);
    const page = await c.get('x');
    expect(page).toEqual({
      id: '',
      status: 'current',
      title: '',
      space_id: '',
      space_key: undefined,
      parent_id: null,
      version: 1,
      body_storage: undefined,
      web_url: undefined,
    });
  });

  it('mapV2ChildPage maps a child page (version is always null — re-fetch to update)', async () => {
    client.get.mockResolvedValueOnce({
      results: [{ id: 'c1', spaceId: '900', parentId: '1', version: { number: 5 } }],
    });
    const c = createConfluencePagesClient(client);
    expect((await c.getChildren('1'))[0]).toMatchObject({
      id: 'c1',
      space_id: '900',
      parent_id: '1',
      version: null,
    });
  });

  it('mapV1SearchResult handles a result with no space/version/links and no type field', async () => {
    client.get.mockResolvedValueOnce({ results: [{ id: '1', title: 'P' }] });
    const c = createConfluencePagesClient(client);
    expect((await c.search({ cql: 'x' }))[0]).toEqual({
      id: '1',
      status: 'current',
      title: 'P',
      space_id: '',
      space_key: undefined,
      parent_id: null,
      version: null,
      web_url: undefined,
    });
  });

  it('mapV1SearchResult keeps a result whose type is explicitly "page"', async () => {
    client.get.mockResolvedValueOnce({
      results: [{ id: '1', type: 'page', title: 'P', space: { id: '900' } }],
    });
    const c = createConfluencePagesClient(client);
    expect((await c.search({ cql: 'x' }))[0].space_id).toBe('900');
  });

  it('resolveSpaceId caches the key it learns so a later get() needs no space GET', async () => {
    client.get
      .mockResolvedValueOnce({ results: [{ id: '900', key: 'DEV' }] }) // resolveSpaceId during create
      .mockResolvedValueOnce({}); // get() page below — should NOT trigger a space GET
    client.post.mockResolvedValueOnce(v2Page());
    const c = createConfluencePagesClient(client);
    await c.create({ spaceKey: 'DEV', title: 'T', body: { text: 'x' } });
    // create's enrich() uses the page's spaceId (900) → already cached → no space GET.
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  it('getByTitle without includeBody omits body-format', async () => {
    client.get
      .mockResolvedValueOnce({ results: [{ id: '900', key: 'DEV' }] })
      .mockResolvedValueOnce({ results: [v2Page()] });
    const c = createConfluencePagesClient(client);
    await c.getByTitle('DEV', 'My Page');
    expect(client.get).toHaveBeenNthCalledWith(2, '/wiki/api/v2/pages', {
      'space-id': '900',
      title: 'My Page',
      limit: 1,
    });
  });

  it('update keeps the existing status when the page payload omits it', async () => {
    client.get
      .mockResolvedValueOnce({ id: '123', title: 'T', spaceId: '900', version: { number: 1 } })
      .mockResolvedValueOnce({ key: 'DEV' });
    client.put.mockResolvedValueOnce(v2Page());
    const c = createConfluencePagesClient(client);
    await c.update('123', { title: 'X' });
    expect((client.put.mock.calls[0][1] as { status: string }).status).toBe('current');
  });
});
