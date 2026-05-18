/**
 * Tests for {@link ./pages-client.ts} — Graph URL builders + request helpers
 * for the SharePoint Pages API.
 *
 * Black-box: we feed a fake {@link GraphRequester} (records every call) and
 * assert that `PagesClient` produces the Graph paths Microsoft documents for
 * `microsoft.graph.sitePage` and the canvasLayout web-part endpoints.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  PagesClient,
  PAGE_RESOURCE,
  TEXT_WEBPART_ENVELOPE_TYPE,
  TEXT_WEBPART_PROPERTIES_TYPE,
  STANDARD_WEBPART_ENVELOPE_TYPE,
  STANDARD_WEBPART_TYPES,
  buildTextWebPartBody,
  buildStandardWebPartBody,
  buildImageWebPartData,
  htmlToPlainText,
  extractHeadings,
  injectHeadingAnchors,
  slugifyHeading,
  renderTableOfContents,
  stripUiOnlyWebPartFields,
  UI_ONLY_WEBPART_FIELDS,
} from './pages-client.js';
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
    // Per-web-part PATCH/DELETE goes to the documented `/webParts/{id}` form.
    // The PR4 empty-segments form (`.../horizontalSections/columns/webparts/{id}`)
    // returned `Resource not found` from Graph (live-tested).
    const r = fakeRequester();
    expect(new PagesClient(r).webpartItemPath('p1', 'wp1')).toBe(
      `/sites/${SITE_ID}/pages/p1/${PAGE_RESOURCE}/webParts/wp1`
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

  it('patchPage PATCHes an arbitrary sitePage subset (metadata fields)', async () => {
    const r = fakeRequester();
    const body = {
      title: 'New title',
      showComments: false,
      titleArea: { '@odata.type': '#microsoft.graph.titleArea', imageWebUrl: 'https://x' },
    };
    await new PagesClient(r).patchPage('p1', body);
    expect(r.graphRequest).toHaveBeenCalledWith(
      'PATCH',
      `/sites/${SITE_ID}/pages/p1/${PAGE_RESOURCE}`,
      body
    );
  });

  it('patchPage strips UI-only web part fields from canvasLayout before PATCH', async () => {
    const r = fakeRequester();
    const body = {
      title: 'X',
      canvasLayout: {
        horizontalSections: [
          {
            id: 's',
            columns: [
              {
                id: 'c',
                webparts: [
                  {
                    id: 'wp1',
                    innerHtml: '<p>x</p>',
                    customContentDropSupport: 'externallink',
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    await new PagesClient(r).patchPage('p1', body);
    const [, , sentBody] = (r.graphRequest as ReturnType<typeof vi.fn>).mock.calls[0];
    const sentWebpart = (
      sentBody as {
        canvasLayout: {
          horizontalSections: { columns: { webparts: Record<string, unknown>[] }[] }[];
        };
      }
    ).canvasLayout.horizontalSections[0].columns[0].webparts[0];
    expect(sentWebpart).not.toHaveProperty('customContentDropSupport');
    expect(sentWebpart.innerHtml).toBe('<p>x</p>');
  });

  it('addTextWebPart POSTs the createWebPart envelope to the section/column', async () => {
    const r = fakeRequester();
    await new PagesClient(r).addTextWebPart('p1', 'sec1', 'col1', '<p>Hi</p>');
    expect(r.graphRequest).toHaveBeenCalledWith(
      'POST',
      `/sites/${SITE_ID}/pages/p1/${PAGE_RESOURCE}` +
        `/canvasLayout/horizontalSections/sec1/columns/col1/webparts`,
      buildTextWebPartBody('<p>Hi</p>')
    );
  });

  it('updateTextWebPart PATCHes the documented `/webParts/{id}` endpoint with the createWebPart envelope', async () => {
    const r = fakeRequester();
    await new PagesClient(r).updateTextWebPart('p1', 'wp1', '<p>new</p>');
    expect(r.graphRequest).toHaveBeenCalledWith(
      'PATCH',
      `/sites/${SITE_ID}/pages/p1/${PAGE_RESOURCE}/webParts/wp1`,
      buildTextWebPartBody('<p>new</p>')
    );
  });

  it('buildTextWebPartBody produces the Graph-documented envelope shape', () => {
    expect(buildTextWebPartBody('<p>Hi <b>world</b></p>')).toEqual({
      '@odata.type': TEXT_WEBPART_ENVELOPE_TYPE,
      webPartProperties: {
        '@odata.type': TEXT_WEBPART_PROPERTIES_TYPE,
        data: {
          content: {
            formattedValue: '<p>Hi <b>world</b></p>',
            value: 'Hi world',
          },
        },
      },
    });
  });

  it('buildStandardWebPartBody emits the envelope with webPartType and optional data', () => {
    expect(buildStandardWebPartBody(STANDARD_WEBPART_TYPES.divider)).toEqual({
      '@odata.type': STANDARD_WEBPART_ENVELOPE_TYPE,
      webPartType: STANDARD_WEBPART_TYPES.divider,
    });
    expect(buildStandardWebPartBody(STANDARD_WEBPART_TYPES.image, { title: 'Hero' })).toEqual({
      '@odata.type': STANDARD_WEBPART_ENVELOPE_TYPE,
      webPartType: STANDARD_WEBPART_TYPES.image,
      data: { '@odata.type': '#microsoft.graph.webPartData', title: 'Hero' },
    });
  });

  it('buildImageWebPartData produces a Save-and-Close-safe payload pinned to a driveItem', () => {
    const data = buildImageWebPartData(
      'https://contoso.sharepoint.com/sites/x/Shared%20Documents/hero.jpg',
      {
        siteId: 'site-guid',
        webId: 'web-guid',
        listId: 'list-guid',
        listItemUniqueId: 'item-guid',
      },
      { width: 1920, height: 1080 },
      { altText: 'Speedwave hero', captionText: 'Hello', alignment: 'Left' }
    );
    expect(data).toEqual({
      dataVersion: '1.9',
      description: 'Show an image on your page',
      title: 'Image',
      properties: {
        imageSourceType: 2,
        altText: 'Speedwave hero',
        overlayText: '',
        siteid: 'site-guid',
        webid: 'web-guid',
        listid: 'list-guid',
        uniqueid: 'item-guid',
        imgWidth: 1920,
        imgHeight: 1080,
        fixAspectRatio: false,
        captionText: 'Hello',
        alignment: 'Left',
      },
      serverProcessedContent: {
        imageSources: [
          {
            key: 'imageSource',
            value: 'https://contoso.sharepoint.com/sites/x/Shared%20Documents/hero.jpg',
          },
        ],
        customMetadata: [
          {
            key: 'imageSource',
            value: {
              siteid: 'site-guid',
              webid: 'web-guid',
              listid: 'list-guid',
              uniqueid: 'item-guid',
              width: '1920',
              height: '1080',
            },
          },
        ],
      },
    });
  });

  it('stripUiOnlyWebPartFields removes UI-only fields at every depth and preserves the rest', () => {
    const input = {
      horizontalSections: [
        {
          id: 's',
          customContentDropSupport: 'should-be-stripped-at-section',
          columns: [
            {
              id: 'c',
              webparts: [
                {
                  id: 'wp1',
                  innerHtml: '<p>keep</p>',
                  customContentDropSupport: 'externallink',
                  data: { title: 'T' },
                },
              ],
            },
          ],
        },
      ],
    };
    const out = stripUiOnlyWebPartFields(input);
    expect(JSON.stringify(out)).not.toContain('customContentDropSupport');
    expect(out).toEqual({
      horizontalSections: [
        {
          id: 's',
          columns: [
            {
              id: 'c',
              webparts: [{ id: 'wp1', innerHtml: '<p>keep</p>', data: { title: 'T' } }],
            },
          ],
        },
      ],
    });
    // Original input untouched (deep clone semantics).
    expect(input.horizontalSections[0].columns[0].webparts[0]).toHaveProperty(
      'customContentDropSupport'
    );
  });

  it('UI_ONLY_WEBPART_FIELDS is a non-empty list', () => {
    expect(UI_ONLY_WEBPART_FIELDS.length).toBeGreaterThan(0);
    expect(UI_ONLY_WEBPART_FIELDS).toContain('customContentDropSupport');
  });

  it('buildImageWebPartData defaults alignment to Center and tolerates missing dimensions', () => {
    const data = buildImageWebPartData(
      'https://x/y.jpg',
      { siteId: 's', webId: 'w', listId: 'l', listItemUniqueId: 'u' },
      undefined
    );
    const properties = (data as { properties: Record<string, unknown> }).properties;
    expect(properties.alignment).toBe('Center');
    expect(properties.imgWidth).toBeUndefined();
    expect(properties.imgHeight).toBeUndefined();
    const customMetadata = (
      data as {
        serverProcessedContent: {
          customMetadata: { value: { width: string; height: string } }[];
        };
      }
    ).serverProcessedContent.customMetadata;
    expect(customMetadata[0].value.width).toBe('');
    expect(customMetadata[0].value.height).toBe('');
  });

  it('STANDARD_WEBPART_TYPES contains 13 entries — Graph supports 14 in the official table but Title Area is a sitePage property, not a standardWebPart', () => {
    expect(Object.keys(STANDARD_WEBPART_TYPES)).toHaveLength(13);
    // Title Area must NOT be exposed via addWebPart — it lives on sitePage.titleArea.
    expect(Object.keys(STANDARD_WEBPART_TYPES)).not.toContain('titleArea');
    // GUIDs are lowercase 8-4-4-4-12 hex.
    for (const guid of Object.values(STANDARD_WEBPART_TYPES)) {
      expect(guid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  it('addStandardWebPart POSTs the envelope with optional data', async () => {
    const r = fakeRequester();
    await new PagesClient(r).addStandardWebPart(
      'p1',
      'sec1',
      'col1',
      STANDARD_WEBPART_TYPES.image,
      { title: 'Hero' }
    );
    expect(r.graphRequest).toHaveBeenCalledWith(
      'POST',
      `/sites/${SITE_ID}/pages/p1/${PAGE_RESOURCE}` +
        `/canvasLayout/horizontalSections/sec1/columns/col1/webparts`,
      buildStandardWebPartBody(STANDARD_WEBPART_TYPES.image, { title: 'Hero' })
    );
  });

  it('htmlToPlainText strips tags and decodes safe entities (preserves &lt; / &gt;)', () => {
    // Stripping tags first leaves spaces at tag boundaries; that is fine for
    // the screen-reader / search-index field the value is used for.
    expect(htmlToPlainText('<p>Hello&nbsp;<b>world</b> &amp; goodbye</p>')).toBe(
      'Hello world & goodbye'
    );
    // Angle-bracket entities are preserved verbatim — never decoded back to
    // `<` / `>` to keep the `value` field XSS-safe for downstream consumers.
    expect(htmlToPlainText('&lt;tag&gt;')).toBe('&lt;tag&gt;');
    expect(htmlToPlainText('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
    expect(htmlToPlainText('&quot;quoted&quot; &#39;single&#39;')).toBe('"quoted" \'single\'');
    expect(htmlToPlainText('   ')).toBe('');
  });

  it('removeWebPart DELETEs at the dedicated webpart endpoint', async () => {
    const r = fakeRequester();
    await new PagesClient(r).removeWebPart('p1', 'wp1');
    expect(r.graphRequest).toHaveBeenCalledWith(
      'DELETE',
      `/sites/${SITE_ID}/pages/p1/${PAGE_RESOURCE}/webParts/wp1`
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

describe('Table-of-contents helpers', () => {
  it('extractHeadings pulls h1–h6 in document order', () => {
    const html =
      '<h1>Intro</h1><p>x</p><h2 id="setup">Setup</h2><h3>Step 1</h3><h2>Conclusion</h2>';
    const headings = extractHeadings(html);
    expect(headings).toEqual([
      { level: 1, anchor: 'intro', text: 'Intro' },
      { level: 2, anchor: 'setup', text: 'Setup' }, // explicit id preserved
      { level: 3, anchor: 'step-1', text: 'Step 1' },
      { level: 2, anchor: 'conclusion', text: 'Conclusion' },
    ]);
  });

  it('extractHeadings skips empty headings and decodes entities', () => {
    expect(extractHeadings('<h2>  </h2><h3>Bug &amp; Fix</h3>')).toEqual([
      { level: 3, anchor: 'bug-fix', text: 'Bug & Fix' },
    ]);
  });

  it('extractHeadings deduplicates colliding slugs within a single web part', () => {
    expect(extractHeadings('<h2>Setup</h2><h3>Details</h3><h2>Setup</h2>')).toEqual([
      { level: 2, anchor: 'setup', text: 'Setup' },
      { level: 3, anchor: 'details', text: 'Details' },
      { level: 2, anchor: 'setup-2', text: 'Setup' },
    ]);
  });

  it('extractHeadings accepts unquoted id attributes (HTML5)', () => {
    expect(extractHeadings('<h2 id=manual class=x>Manual</h2>')).toEqual([
      { level: 2, anchor: 'manual', text: 'Manual' },
    ]);
  });

  it('injectHeadingAnchors adds id="…" only on headings that lack one', () => {
    const headings = extractHeadings('<h1>Intro</h1><h2 id="setup">Setup</h2><h2>End</h2>');
    expect(
      injectHeadingAnchors('<h1>Intro</h1><h2 id="setup">Setup</h2><h2>End</h2>', headings)
    ).toBe('<h1 id="intro">Intro</h1><h2 id="setup">Setup</h2><h2 id="end">End</h2>');
  });

  it('injectHeadingAnchors leaves surrounding content untouched', () => {
    const input = '<p>before</p><h2>Mid</h2><p>after</p>';
    const headings = extractHeadings(input);
    expect(injectHeadingAnchors(input, headings)).toBe(
      '<p>before</p><h2 id="mid">Mid</h2><p>after</p>'
    );
  });

  it('injectHeadingAnchors is a no-op when every heading already has an id', () => {
    const input = '<h2 id="a">A</h2><h3 id="b">B</h3>';
    const headings = extractHeadings(input);
    expect(injectHeadingAnchors(input, headings)).toBe(input);
  });

  it('slugifyHeading produces kebab-case ASCII', () => {
    expect(slugifyHeading('Hello World')).toBe('hello-world');
    // NFKD decomposes a + combining acute; bare `Ł`/`ł` are not decomposable
    // and fall through the non-ASCII filter as separators (single letters
    // without accents survive).
    expect(slugifyHeading('Café — naprawdę')).toBe('cafe-naprawde');
    expect(slugifyHeading('   --- ')).toBe('');
  });

  it('renderTableOfContents nests deeper levels inside the parent <li> (valid HTML)', () => {
    const headings = [
      { level: 1, anchor: 'a', text: 'A' },
      { level: 2, anchor: 'a1', text: 'A1' },
      { level: 2, anchor: 'a2', text: 'A2' },
      { level: 1, anchor: 'b', text: 'B' },
    ];
    const html = renderTableOfContents(headings);
    expect(html).toBe(
      '<ul>' +
        '<li><a href="#a">A</a>' +
        '<ul>' +
        '<li><a href="#a1">A1</a></li>' +
        '<li><a href="#a2">A2</a></li>' +
        '</ul>' +
        '</li>' +
        '<li><a href="#b">B</a></li>' +
        '</ul>'
    );
  });

  it('renderTableOfContents bridges level skips with empty intermediate <li>', () => {
    // h1 → h3 (skips h2). Result must remain well-formed: <ul><li><ul><li><ul><li>…
    const html = renderTableOfContents([
      { level: 1, anchor: 'a', text: 'A' },
      { level: 3, anchor: 'a-c', text: 'A.x.c' },
    ]);
    expect(html).toBe(
      '<ul>' +
        '<li><a href="#a">A</a>' +
        '<ul>' +
        '<li>' +
        '<ul>' +
        '<li><a href="#a-c">A.x.c</a></li>' +
        '</ul>' +
        '</li>' +
        '</ul>' +
        '</li>' +
        '</ul>'
    );
  });

  it('renderTableOfContents emits an optional title heading', () => {
    expect(renderTableOfContents([{ level: 1, anchor: 'x', text: 'X' }], 'Contents')).toBe(
      '<h2>Contents</h2><ul><li><a href="#x">X</a></li></ul>'
    );
  });

  it('renderTableOfContents on empty list returns the title only (or empty)', () => {
    expect(renderTableOfContents([])).toBe('');
    expect(renderTableOfContents([], 'Index')).toBe('<h2>Index</h2>');
  });

  it('renderTableOfContents escapes HTML in text and anchors', () => {
    const html = renderTableOfContents([{ level: 1, anchor: 'a"b', text: 'A <b>&amp;</b>' }]);
    expect(html).toContain('href="#a&quot;b"');
    expect(html).toContain('A &lt;b&gt;&amp;amp;&lt;/b&gt;');
  });
});
