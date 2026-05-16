/**
 * Tests for {@link ./lists-client.ts} — Graph URL builders + request helpers
 * for the SharePoint Lists API.
 */
import { describe, it, expect, vi } from 'vitest';
import { ListsClient } from './lists-client.js';
import type { GraphRequester } from './site-client.js';

const SITE_ID = 'speednet.sharepoint.com,abc,def';

function fakeRequester(): GraphRequester & {
  graphRequest: ReturnType<typeof vi.fn>;
} {
  return {
    getSiteId: () => SITE_ID,
    graphRequest: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ListsClient URL builders', () => {
  it('listsPath is /sites/{site-id}/lists', () => {
    expect(new ListsClient(fakeRequester()).listsPath()).toBe(`/sites/${SITE_ID}/lists`);
  });

  it('listPath addresses a single list', () => {
    expect(new ListsClient(fakeRequester()).listPath('L1')).toBe(`/sites/${SITE_ID}/lists/L1`);
  });

  it('itemsPath and itemPath are the items collection / item', () => {
    const c = new ListsClient(fakeRequester());
    expect(c.itemsPath('L1')).toBe(`/sites/${SITE_ID}/lists/L1/items`);
    expect(c.itemPath('L1', 'I1')).toBe(`/sites/${SITE_ID}/lists/L1/items/I1`);
  });
});

describe('ListsClient request helpers', () => {
  it('getList expands columns', async () => {
    const r = fakeRequester();
    await new ListsClient(r).getList('L1');
    expect(r.graphRequest).toHaveBeenCalledWith(
      'GET',
      `/sites/${SITE_ID}/lists/L1?$expand=columns`
    );
  });

  it('listItems always passes $expand=fields and appends extras with `&`', async () => {
    const r = fakeRequester();
    await new ListsClient(r).listItems('L1', ['$top=10', '$filter=fields/Title%20eq%20%27x%27']);
    expect(r.graphRequest).toHaveBeenCalledWith(
      'GET',
      `/sites/${SITE_ID}/lists/L1/items?$expand=fields&$top=10&$filter=fields/Title%20eq%20%27x%27`
    );
  });

  it('updateItem PATCHes the per-item /fields endpoint', async () => {
    const r = fakeRequester();
    await new ListsClient(r).updateItem('L1', 'I1', { Title: 'new' });
    expect(r.graphRequest).toHaveBeenCalledWith(
      'PATCH',
      `/sites/${SITE_ID}/lists/L1/items/I1/fields`,
      { Title: 'new' }
    );
  });

  it('createItem POSTs to the items collection', async () => {
    const r = fakeRequester();
    await new ListsClient(r).createItem('L1', { fields: { Title: 'x' } });
    expect(r.graphRequest).toHaveBeenCalledWith('POST', `/sites/${SITE_ID}/lists/L1/items`, {
      fields: { Title: 'x' },
    });
  });

  it('deleteList DELETEs the list', async () => {
    const r = fakeRequester();
    await new ListsClient(r).deleteList('L1');
    expect(r.graphRequest).toHaveBeenCalledWith('DELETE', `/sites/${SITE_ID}/lists/L1`);
  });
});

describe('ListsClient never accepts a site_id from callers (ADR-060)', () => {
  it('all URL builders resolve siteId through GraphRequester', async () => {
    let calls = 0;
    const r: GraphRequester = {
      getSiteId: () => {
        calls += 1;
        return SITE_ID;
      },
      graphRequest: vi.fn().mockResolvedValue(undefined),
    };
    const c = new ListsClient(r);
    await c.listLists();
    await c.getList('L1');
    await c.deleteList('L1');
    expect(calls).toBeGreaterThanOrEqual(3);
  });
});
