/**
 * Graph URL builders for the SharePoint Pages API
 * (`microsoft.graph.sitePage` resource and `canvasLayout` web-part endpoints).
 *
 * All URL construction for the pages domain lives here so the tool layer never
 * concatenates Graph paths directly. The single rule: the site id is always
 * resolved through `GraphRequester.getSiteId()` — no tool may accept `site_id`
 * from the model (ADR-060 site-policy invariant).
 *
 * Endpoint set (PR4):
 *   - `GET    /sites/{site-id}/pages/microsoft.graph.sitePage`
 *   - `GET    /sites/{site-id}/pages/{page-id}/microsoft.graph.sitePage?$expand=canvasLayout`
 *   - `POST   /sites/{site-id}/pages`                                              (createPage)
 *   - `PATCH  /sites/{site-id}/pages/{page-id}/microsoft.graph.sitePage`          (updatePage)
 *   - `POST   .../canvasLayout/horizontalSections/{section-id}/columns/{col-id}/webparts`
 *   - `PATCH  .../canvasLayout/horizontalSections/columns/webparts/{webpart-id}`
 *   - `DELETE .../canvasLayout/horizontalSections/columns/webparts/{webpart-id}`
 *   - `POST   /sites/{site-id}/pages/{page-id}/microsoft.graph.sitePage/publish`
 */
import type { GraphRequester } from './site-client.js';

/** Graph cast segment that scopes a generic `baseSitePage` to a `sitePage`. */
export const PAGE_RESOURCE = 'microsoft.graph.sitePage';
/** `@odata.type` discriminator for text web parts (MVP — PR4). */
export const TEXT_WEBPART_TYPE = '#microsoft.graph.textWebPart';

/**
 * Builder of Graph paths for the pages domain. Stateless apart from the
 *  shared {@link GraphRequester} which owns the configured `siteId`.
 */
export class PagesClient {
  /**
   * Build a Graph URL+request helper for the pages domain.
   * @param graph - shared Graph requester owning the siteId + auth state
   */
  constructor(private readonly graph: GraphRequester) {}

  // -- low-level URL builders ------------------------------------------------

  /** `/sites/{site-id}/pages` — the collection of pages on this site. */
  pagesPath(): string {
    return `/sites/${this.graph.getSiteId()}/pages`;
  }

  /**
   * `/sites/{site-id}/pages/{page-id}/microsoft.graph.sitePage`.
   * @param pageId - Graph id of the page
   */
  pagePath(pageId: string): string {
    return `${this.pagesPath()}/${pageId}/${PAGE_RESOURCE}`;
  }

  /**
   * `.../canvasLayout/horizontalSections/{section-id}/columns/{column-id}/webparts`
   *  — POST endpoint used by `addWebPart`.
   * @param pageId - Graph id of the page
   * @param sectionId - Graph id of the horizontal section
   * @param columnId - Graph id of the column inside the section
   */
  webpartsCollectionPath(pageId: string, sectionId: string, columnId: string): string {
    return (
      `${this.pagePath(pageId)}` +
      `/canvasLayout/horizontalSections/${sectionId}/columns/${columnId}/webparts`
    );
  }

  /**
   * `.../canvasLayout/horizontalSections/columns/webparts/{webpart-id}` —
   *  PATCH / DELETE endpoint Graph exposes for per-web-part operations
   *  (sectionId / columnId omitted; Graph routes by webpart id).
   * @param pageId - Graph id of the page
   * @param webpartId - Graph id of the web part
   */
  webpartItemPath(pageId: string, webpartId: string): string {
    return (
      `${this.pagePath(pageId)}` + `/canvasLayout/horizontalSections/columns/webparts/${webpartId}`
    );
  }

  // -- request helpers -------------------------------------------------------

  /** `GET /sites/{site-id}/pages/microsoft.graph.sitePage?$select=id,name,title,webUrl`. */
  listPages<T = unknown>(): Promise<T | undefined> {
    const url = `${this.pagesPath()}/${PAGE_RESOURCE}?$select=id,name,title,webUrl`;
    return this.graph.graphRequest<T>('GET', url);
  }

  /**
   * `GET .../{page-id}/microsoft.graph.sitePage?$expand=canvasLayout`.
   * @param pageId - target page id
   */
  getPage<T = unknown>(pageId: string): Promise<T | undefined> {
    return this.graph.graphRequest<T>('GET', `${this.pagePath(pageId)}?$expand=canvasLayout`);
  }

  /**
   * `POST /sites/{site-id}/pages` with a `#microsoft.graph.sitePage` body.
   * @param body - the page payload (must include `@odata.type`, `name`, `title`)
   */
  createPage<T = unknown>(body: Record<string, unknown>): Promise<T | undefined> {
    return this.graph.graphRequest<T>('POST', this.pagesPath(), body);
  }

  /**
   * `PATCH .../{page-id}/microsoft.graph.sitePage` — full canvasLayout.
   * @param pageId - target page id
   * @param canvasLayout - complete canvasLayout (Graph requires the FULL layout)
   */
  updatePage(pageId: string, canvasLayout: unknown): Promise<unknown> {
    return this.graph.graphRequest('PATCH', this.pagePath(pageId), { canvasLayout });
  }

  /**
   * `POST` a text web part into the addressed section/column.
   * @param pageId - target page id
   * @param sectionId - section Graph id
   * @param columnId - column Graph id within the section
   * @param innerHtml - HTML body of the text web part
   */
  addTextWebPart<T = unknown>(
    pageId: string,
    sectionId: string,
    columnId: string,
    innerHtml: string
  ): Promise<T | undefined> {
    return this.graph.graphRequest<T>(
      'POST',
      this.webpartsCollectionPath(pageId, sectionId, columnId),
      { '@odata.type': TEXT_WEBPART_TYPE, innerHtml }
    );
  }

  /**
   * `PATCH` a text web part by id — replaces `innerHtml`.
   * @param pageId - target page id
   * @param webpartId - Graph id of the web part
   * @param innerHtml - new HTML body
   */
  updateTextWebPart(pageId: string, webpartId: string, innerHtml: string): Promise<unknown> {
    return this.graph.graphRequest('PATCH', this.webpartItemPath(pageId, webpartId), {
      '@odata.type': TEXT_WEBPART_TYPE,
      innerHtml,
    });
  }

  /**
   * `DELETE` a web part by id.
   * @param pageId - target page id
   * @param webpartId - Graph id of the web part
   */
  removeWebPart(pageId: string, webpartId: string): Promise<unknown> {
    return this.graph.graphRequest('DELETE', this.webpartItemPath(pageId, webpartId));
  }

  /**
   * `POST /publish` — make a draft page visible.
   * @param pageId - target page id
   */
  publishPage(pageId: string): Promise<unknown> {
    return this.graph.graphRequest('POST', `${this.pagePath(pageId)}/publish`);
  }

  /**
   * `DELETE /sites/{site-id}/pages/{page-id}` — remove the page.
   * @param pageId - target page id
   */
  deletePage(pageId: string): Promise<unknown> {
    return this.graph.graphRequest('DELETE', `${this.pagesPath()}/${pageId}`);
  }
}
