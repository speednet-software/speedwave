/**
 * Tests for {@link ./pages-client.ts} — Graph URL builders + request helpers
 * for the SharePoint Pages API.
 *
 * Black-box: we feed a fake {@link GraphRequester} (records every call) and
 * assert that `PagesClient` produces the Graph paths Microsoft documents for
 * `microsoft.graph.sitePage` and the canvasLayout web-part endpoints.
 */
import { describe, it, expect, vi } from 'vitest';
import { PagesClient, PAGE_RESOURCE, TEXT_WEBPART_TYPE } from './pages-client.js';
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

describe('PagesClient URL builders', () => {
  it('pagesPath = /sites/{site-id}/pages', () => {
    const r = fakeRequester();
    expect(new PagesClient(r).pagesPath()).toBe(`/sites/${SITE_ID}/pages`);
  });

  it('pagePath includes the sitePage cast segment', () => {
    const r = fakeRequester();
    expect(new PagesClient(r).pagePath('p1')).toBe(`/sites/${SITE_ID}/pages/p1/${PAGE_RESOURCE}`);
  });

  it('webpartsCollectionPath addresses a specific column', () => {
    const r = fakeRequester();
    expect(new PagesClient(r).webpartsCollectionPath('p1', 'sec1', 'col1')).toBe(
      `/sites/${SITE_ID}/pages/p1/${PAGE_RESOURCE}` +
        `/canvasLayout/horizontalSections/sec1/columns/col1/webparts`
    );
  });

  it('webpartItemPath omits section/column ids — Graph routes by webpart id', () => {
    // Graph quirk: per-web-part PATCH/DELETE only needs the web-part id, but
    // the URL template keeps the empty `horizontalSections/columns` segments.
    const r = fakeRequester();
    expect(new PagesClient(r).webpartItemPath('p1', 'wp1')).toBe(
      `/sites/${SITE_ID}/pages/p1/${PAGE_RESOURCE}` +
        `/canvasLayout/horizontalSections/columns/webparts/wp1`
    );
  });
});

describe('PagesClient request helpers', () => {
  it('listPages issues GET with $select for the common projection', async () => {
    const r = fakeRequester();
    await new PagesClient(r).listPages();
    expect(r.graphRequest).toHaveBeenCalledWith(
      'GET',
      `/sites/${SITE_ID}/pages/${PAGE_RESOURCE}?$select=id,name,title,webUrl`
    );
  });

  it('getPage expands canvasLayout', async () => {
    const r = fakeRequester();
    await new PagesClient(r).getPage('p1');
    expect(r.graphRequest).toHaveBeenCalledWith(
      'GET',
      `/sites/${SITE_ID}/pages/p1/${PAGE_RESOURCE}?$expand=canvasLayout`
    );
  });

  it('createPage POSTs the provided body to /pages', async () => {
    const r = fakeRequester();
    const body = { '@odata.type': `#${PAGE_RESOURCE}`, name: 'hi.aspx', title: 'Hi' };
    await new PagesClient(r).createPage(body);
    expect(r.graphRequest).toHaveBeenCalledWith('POST', `/sites/${SITE_ID}/pages`, body);
  });

  it('updatePage PATCHes the FULL canvasLayout (Graph requirement)', async () => {
    const r = fakeRequester();
    const layout = { horizontalSections: [{ id: 's', columns: [{ id: 'c' }] }] };
    await new PagesClient(r).updatePage('p1', layout);
    expect(r.graphRequest).toHaveBeenCalledWith(
      'PATCH',
      `/sites/${SITE_ID}/pages/p1/${PAGE_RESOURCE}`,
      { canvasLayout: layout }
    );
  });

  it('addTextWebPart POSTs a textWebPart payload to the section/column', async () => {
    const r = fakeRequester();
    await new PagesClient(r).addTextWebPart('p1', 'sec1', 'col1', '<p>Hi</p>');
    expect(r.graphRequest).toHaveBeenCalledWith(
      'POST',
      `/sites/${SITE_ID}/pages/p1/${PAGE_RESOURCE}` +
        `/canvasLayout/horizontalSections/sec1/columns/col1/webparts`,
      { '@odata.type': TEXT_WEBPART_TYPE, innerHtml: '<p>Hi</p>' }
    );
  });

  it('updateTextWebPart PATCHes the dedicated webpart endpoint with the textWebPart cast', async () => {
    const r = fakeRequester();
    await new PagesClient(r).updateTextWebPart('p1', 'wp1', '<p>new</p>');
    expect(r.graphRequest).toHaveBeenCalledWith(
      'PATCH',
      `/sites/${SITE_ID}/pages/p1/${PAGE_RESOURCE}` +
        `/canvasLayout/horizontalSections/columns/webparts/wp1`,
      { '@odata.type': TEXT_WEBPART_TYPE, innerHtml: '<p>new</p>' }
    );
  });

  it('removeWebPart DELETEs at the dedicated webpart endpoint', async () => {
    const r = fakeRequester();
    await new PagesClient(r).removeWebPart('p1', 'wp1');
    expect(r.graphRequest).toHaveBeenCalledWith(
      'DELETE',
      `/sites/${SITE_ID}/pages/p1/${PAGE_RESOURCE}` +
        `/canvasLayout/horizontalSections/columns/webparts/wp1`
    );
  });

  it('publishPage POSTs to /publish', async () => {
    const r = fakeRequester();
    await new PagesClient(r).publishPage('p1');
    expect(r.graphRequest).toHaveBeenCalledWith(
      'POST',
      `/sites/${SITE_ID}/pages/p1/${PAGE_RESOURCE}/publish`
    );
  });

  it('deletePage DELETEs at /sites/{site-id}/pages/{page-id} (no cast)', async () => {
    // deletePage uses the base /pages collection — the sitePage cast is for
    // GET/PATCH only. We assert that explicitly to lock the behaviour in.
    const r = fakeRequester();
    await new PagesClient(r).deletePage('p1');
    expect(r.graphRequest).toHaveBeenCalledWith('DELETE', `/sites/${SITE_ID}/pages/p1`);
  });
});

describe('PagesClient never accepts a site_id from callers (ADR-060)', () => {
  it('reads siteId only from GraphRequester.getSiteId()', async () => {
    let calls = 0;
    const r: GraphRequester = {
      getSiteId: () => {
        calls += 1;
        return SITE_ID;
      },
      graphRequest: vi.fn().mockResolvedValue(undefined),
    };
    const pages = new PagesClient(r);
    await pages.listPages();
    await pages.getPage('p1');
    await pages.publishPage('p1');
    // Every URL builder must call back through GraphRequester — never cache
    // or accept a caller-supplied site id.
    expect(calls).toBeGreaterThanOrEqual(3);
  });
});
