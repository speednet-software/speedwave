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
 *   - `PATCH  /sites/{site-id}/pages/{page-id}/microsoft.graph.sitePage/webParts/{webpart-id}`
 *   - `DELETE /sites/{site-id}/pages/{page-id}/microsoft.graph.sitePage/webParts/{webpart-id}`
 *   - `POST   /sites/{site-id}/pages/{page-id}/microsoft.graph.sitePage/publish`
 */
import type { GraphRequester } from './site-client.js';

/** Graph cast segment that scopes a generic `baseSitePage` to a `sitePage`. */
export const PAGE_RESOURCE = 'microsoft.graph.sitePage';
/**
 * `@odata.type` discriminators for the createWebPart endpoint. Graph treats
 * the outer (envelope) type and the inner (properties) type as distinct values
 * with different capitalisation — verified against the official endpoint docs.
 * Sending `#microsoft.graph.textWebPart` as the envelope (PR4 MVP wording)
 * makes Graph respond with 400 Bad Request.
 */
export const TEXT_WEBPART_ENVELOPE_TYPE = '#microsoft.graph.textwebpart';
export const TEXT_WEBPART_PROPERTIES_TYPE = '#microsoft.graph.textwebPart';
export const STANDARD_WEBPART_ENVELOPE_TYPE = '#microsoft.graph.standardwebpart';

/**
 * SSOT map of human-friendly web-part names to the GUIDs Graph expects in
 * the `webPartType` field. Verified against the official "Supported web parts"
 * table in `sitepage-update.md` (Microsoft Graph docs). The table also lists
 * "Title Area" but that is a sitePage property (`sitePage.titleArea`) handled
 * by `updatePage` — it is NOT a standardWebPart you POST to `/webparts`, so
 * it is intentionally absent here. Posting it via addWebPart returns 400.
 */
export const STANDARD_WEBPART_TYPES = {
  bingMaps: 'e377ea37-9047-43b9-8cdb-a761be2f8e09',
  button: '0f087d7f-520e-42b7-89c0-496aaf979d58',
  callToAction: 'df8e44e7-edd5-46d5-90da-aca1539313b8',
  divider: '2161a1c6-db61-4731-b97c-3cdb303f7cbb',
  documentEmbed: 'b7dd04e1-19ce-4b24-9132-b60a1c2b910d',
  image: 'd1d91016-032f-456d-98a4-721247c305e8',
  imageGallery: 'af8be689-990e-492a-81f7-ba3e4cd3ed9c',
  linkPreview: '6410b3b6-d440-4663-8744-378976dc041e',
  orgChart: 'e84a8ca2-f63c-4fb9-bc0b-d8eef5ccb22b',
  people: '7f718435-ee4d-431c-bdbf-9c4ff326f46e',
  quickLinks: 'c70391ea-0b10-4ee9-b2b4-006d3fcad0cd',
  spacer: '8654b779-4886-46d4-8ffb-b5ed960ee986',
  youtubeEmbed: '544dd15b-cf3c-441b-96da-004d5a8cea1d',
} as const satisfies Record<string, string>;

/** One heading extracted from a text web part — drives ToC rendering. */
export interface TocHeading {
  /** 1 = h1, 2 = h2, … */
  level: number;
  /** Anchor id (HTML-safe slug). */
  anchor: string;
  /** Visible text. */
  text: string;
}

/**
 * Pull headings (h1–h6) out of a text web part body and assign anchor ids when
 * they are missing. The returned anchor lives inside the source string only
 * if the caller re-emits it via `injectHeadingAnchors` — this helper is pure.
 * @param innerHtml - text web part HTML
 * @returns ordered list of headings discovered in source order
 */
export function extractHeadings(innerHtml: string): TocHeading[] {
  const results: TocHeading[] = [];
  const re = headingRegex();
  let match: RegExpExecArray | null;
  const usedAnchors = new Set<string>();
  while ((match = re.exec(innerHtml)) !== null) {
    const level = Number.parseInt(match[1], 10);
    const attrs = match[2] ?? '';
    const inner = match[3] ?? '';
    const text = htmlToPlainText(inner);
    if (!text) continue;
    const idMatch = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    let anchor = idMatch ? (idMatch[1] ?? idMatch[2] ?? idMatch[3]) : slugifyHeading(text);
    if (!anchor) anchor = `heading-${results.length + 1}`;
    // Deduplicate within a single web part — Graph + browsers tolerate it but
    // a unique slug per ToC entry keeps click-through deterministic.
    let dedup = anchor;
    let i = 2;
    while (usedAnchors.has(dedup)) {
      dedup = `${anchor}-${i++}`;
    }
    usedAnchors.add(dedup);
    results.push({ level, anchor: dedup, text });
  }
  return results;
}

/**
 * Rewrite `innerHtml` so every heading carries the matching anchor `id`.
 * Headings that already have an id keep it. Caller is responsible for passing
 * `headings` extracted from the SAME `innerHtml` in document order — anchors
 * are zipped positionally. Used by `generateTableOfContents` to make link
 * targets actually resolve.
 *
 * Note on SharePoint: the rich-text sanitizer is not formally documented; in
 * some tenants it strips inline `id` attributes from `<hN>` tags. We still
 * emit them so the ToC works when the sanitizer is permissive and the source
 * HTML is preserved on round-trip.
 * @param innerHtml - original text web part HTML
 * @param headings - headings already extracted from `innerHtml`
 * @returns innerHtml with `id="..."` injected on headings that lacked one
 */
export function injectHeadingAnchors(innerHtml: string, headings: TocHeading[]): string {
  const re = headingRegex();
  let cursor = 0;
  let out = '';
  let i = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(innerHtml)) !== null) {
    const [whole, levelStr, attrs = '', inner = ''] = match;
    out += innerHtml.slice(cursor, match.index);
    cursor = match.index + whole.length;
    const text = htmlToPlainText(inner);
    if (!text) {
      out += whole;
      continue;
    }
    const h = headings[i++];
    if (!h) {
      out += whole;
      continue;
    }
    const hasId = /\bid\s*=/i.test(attrs);
    if (hasId) {
      out += whole;
      continue;
    }
    const escapedAnchor = escapeHtmlAttr(h.anchor);
    const newAttrs = attrs ? `${attrs} id="${escapedAnchor}"` : ` id="${escapedAnchor}"`;
    out += `<h${levelStr}${newAttrs}>${inner}</h${levelStr}>`;
  }
  out += innerHtml.slice(cursor);
  return out;
}

/**
 * Shared regex for `<h1>`…`<h6>` blocks. Returns a fresh instance each call
 *  because `/g` flag carries mutable `lastIndex` state.
 */
function headingRegex(): RegExp {
  return /<h([1-6])(\s[^>]*)?>([\s\S]*?)<\/h\1>/gi;
}

/**
 * Slugify a heading for use as a bookmark anchor. Lower-case, alphanumeric
 * plus dashes; never empty (falls back to "heading-N" via caller if needed).
 * @param text - heading text
 * @returns kebab-case slug
 */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Render a ToC body (HTML) from a list of headings. Nested lists are placed
 * INSIDE the parent `<li>` (valid HTML / a11y), not as siblings. Levels skip
 * gracefully: an `h3` after an `h1` opens one intermediate `<ul>` so the tree
 * stays well-formed.
 * @param headings - extracted headings (h1–h6, preserving order)
 * @param title - optional header rendered above the ToC (`<h2>`)
 * @returns HTML string suitable for a text web part body
 */
export function renderTableOfContents(headings: TocHeading[], title?: string): string {
  if (headings.length === 0) {
    return title ? `<h2>${escapeHtml(title)}</h2>` : '';
  }
  const titleHtml = title ? `<h2>${escapeHtml(title)}</h2>` : '';
  // Stack tracks open elements: 'ul' for open lists, 'li' for open items
  // awaiting either a sibling or a nested list.
  const stack: ('ul' | 'li')[] = [];
  let html = '';

  const closeUntilDepth = (targetUls: number): void => {
    // Close <li>/<ul> pairs until the number of open <ul>s equals targetUls.
    while (stack.filter((t) => t === 'ul').length > targetUls) {
      while (stack.length > 0 && stack[stack.length - 1] === 'li') {
        stack.pop();
        html += '</li>';
      }
      if (stack[stack.length - 1] === 'ul') {
        stack.pop();
        html += '</ul>';
      }
    }
  };

  for (const h of headings) {
    const currentUls = stack.filter((t) => t === 'ul').length;
    if (h.level > currentUls) {
      // Need to descend. Open new <ul> inside the current <li> if there is
      // one, else at the root. Bridge any level gaps with empty <li><ul>.
      let needed = h.level - currentUls;
      while (needed > 0) {
        html += '<ul>';
        stack.push('ul');
        needed--;
        if (needed > 0) {
          // Empty wrapper li to host the next-deeper ul (level skip).
          html += '<li>';
          stack.push('li');
        }
      }
    } else if (h.level < currentUls) {
      // Ascend: close lists down to the target depth, then close the open
      // sibling <li> at that depth so the next <li> is a sibling.
      closeUntilDepth(h.level);
      if (stack[stack.length - 1] === 'li') {
        stack.pop();
        html += '</li>';
      }
    } else {
      // Same level — close the previous sibling <li>.
      if (stack[stack.length - 1] === 'li') {
        stack.pop();
        html += '</li>';
      }
    }
    html += `<li><a href="#${escapeHtmlAttr(h.anchor)}">${escapeHtml(h.text)}</a>`;
    stack.push('li');
  }

  // Drain.
  while (stack.length > 0) {
    const top = stack.pop();
    html += top === 'li' ? '</li>' : '</ul>';
  }

  return titleHtml + html;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeHtmlAttr(s: string): string {
  return escapeHtml(s);
}

/**
 * Fields that the SharePoint UI writes into web part bodies on its own Save
 * pass but that Graph PATCH refuses to accept on a subsequent updatePage
 * round-trip. List grew from live tests (2026-05): `customContentDropSupport`
 * is set by the editor to `"externallink"` for embed-capable parts; the
 * worker does not orchestrate round-trips itself but exports this list so
 * external callers (e.g. the Claude container, helper scripts) can strip
 * the fields before re-PATCHing a layout returned from `getPage`.
 */
export const UI_ONLY_WEBPART_FIELDS = ['customContentDropSupport'] as const;

/**
 * Recursively remove UI-only fields from a canvasLayout returned by `getPage`,
 * so the cleaned layout can be re-PATCHed via `updatePage` without Graph
 * rejecting fields like `customContentDropSupport`. Returns a deep clone
 * (does not mutate the input).
 * @param layout - canvasLayout from `getPage` or any nested subtree
 * @returns the same structure with UI-only fields removed at every depth
 */
export function stripUiOnlyWebPartFields<T>(layout: T): T {
  return walk(layout) as T;
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(walk);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if ((UI_ONLY_WEBPART_FIELDS as readonly string[]).includes(k)) continue;
      out[k] = walk(v);
    }
    return out;
  }
  return value;
}

/** Inputs the caller controls when inserting an image web part. */
export interface ImageWebPartOptions {
  /** Optional alternative text for screen readers. */
  altText?: string;
  /** Optional caption shown under the image in the SharePoint UI. */
  captionText?: string;
  /** "Left" | "Center" | "Right" — SharePoint uses PascalCase. Default `Center`. */
  alignment?: 'Left' | 'Center' | 'Right';
  /** When true, keeps the source aspect ratio. Default `false` (UI default). */
  fixAspectRatio?: boolean;
  /** Overlay caption rendered ON TOP of the image. Default empty. */
  overlayText?: string;
}

/**
 * Build an image web part `data` payload pinned to a real driveItem in the
 * site's drive. SharePoint's UI image-picker reconciliation drops external
 * URLs that lack the driveItem ids, so the worker must always compose the
 * body from a Graph `driveItem` lookup. `imageSourceType: 2` denotes
 * "drive-item" and is the only value that survives "Save & Close" in the UI
 * (verified live 2026-05). Field set reverse-engineered from the official
 * Microsoft example (`sitepage-create.md`) — Graph does not publish a per-
 * type schema.
 * @param imageWebUrl - server-relative URL of the image (driveItem.webUrl)
 * @param sharepointIds - ids from the driveItem facet (see SharePointIds resource)
 * @param sharepointIds.siteId - SharePoint site id
 * @param sharepointIds.webId - SharePoint web id
 * @param sharepointIds.listId - parent list id (Documents library / Site Assets)
 * @param sharepointIds.listItemUniqueId - per-item unique id
 * @param dimensions - image width/height in pixels (driveItem.image facet); pass `undefined` if unknown
 * @param opts - alt text / caption / alignment overrides
 * @returns webPartData payload for `buildStandardWebPartBody`
 */
export function buildImageWebPartData(
  imageWebUrl: string,
  sharepointIds: {
    siteId: string;
    webId: string;
    listId: string;
    listItemUniqueId: string;
  },
  dimensions: { width?: number; height?: number } | undefined,
  opts: ImageWebPartOptions = {}
): Record<string, unknown> {
  const width = dimensions?.width;
  const height = dimensions?.height;
  return {
    dataVersion: '1.9',
    description: 'Show an image on your page',
    title: 'Image',
    properties: {
      imageSourceType: 2,
      altText: opts.altText ?? '',
      overlayText: opts.overlayText ?? '',
      siteid: sharepointIds.siteId,
      webid: sharepointIds.webId,
      listid: sharepointIds.listId,
      uniqueid: sharepointIds.listItemUniqueId,
      imgWidth: width,
      imgHeight: height,
      fixAspectRatio: opts.fixAspectRatio ?? false,
      captionText: opts.captionText ?? '',
      alignment: opts.alignment ?? 'Center',
    },
    serverProcessedContent: {
      imageSources: [{ key: 'imageSource', value: imageWebUrl }],
      customMetadata: [
        {
          key: 'imageSource',
          value: {
            siteid: sharepointIds.siteId,
            webid: sharepointIds.webId,
            listid: sharepointIds.listId,
            uniqueid: sharepointIds.listItemUniqueId,
            width: width !== undefined ? String(width) : '',
            height: height !== undefined ? String(height) : '',
          },
        },
      ],
    },
  };
}

/**
 * Build the createWebPart envelope Graph expects for standard (non-text) web
 * parts. `data` carries the webPart-specific properties (each type has its
 * own schema — see SharePoint UI / SPFx docs for individual shapes).
 * @param webPartType - GUID of the standard web part type
 * @param data - optional webPartData payload (audiences, properties, serverProcessedContent, title, …)
 * @returns request body for POST on a webparts collection
 */
export function buildStandardWebPartBody(
  webPartType: string,
  data?: Record<string, unknown>
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    '@odata.type': STANDARD_WEBPART_ENVELOPE_TYPE,
    webPartType,
  };
  if (data !== undefined) {
    body.data = { '@odata.type': '#microsoft.graph.webPartData', ...data };
  }
  return body;
}

/**
 * Strip HTML tags + decode the safe entities SharePoint Modern Pages uses for
 * the `value` field on text web parts (stored alongside `formattedValue`; used
 * for screen readers and search indexing).
 *
 * Safety note: we DELIBERATELY do not decode `&lt;` / `&gt;` to `<` / `>`. If
 * a downstream consumer renders this `value` field without re-escaping (a
 * known pattern for plain-text fields), turning `&lt;script&gt;` into a real
 * tag would create an XSS sink. Stripping decodes only ampersand, non-break
 * space, quote, and apostrophe — character-level transformations that cannot
 * reintroduce tag syntax.
 * @param html - HTML body of the text web part
 * @returns plain-text equivalent (angle-bracket entities preserved verbatim)
 */
export function htmlToPlainText(html: string): string {
  return (
    html
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      // Decode `&amp;` LAST so an attacker-supplied `&amp;lt;` decodes only to
      // `&lt;` (still an entity), never to `<`.
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Build the createWebPart envelope Graph expects for text web parts. Shape
 * mirrors the official endpoint docs; the inner `value` is derived from
 * `innerHtml` so the screen-reader / search-index field stays in sync.
 * @param innerHtml - HTML body of the text web part
 * @returns request body for POST / PATCH on a webparts collection / item
 */
export function buildTextWebPartBody(innerHtml: string): Record<string, unknown> {
  return {
    '@odata.type': TEXT_WEBPART_ENVELOPE_TYPE,
    webPartProperties: {
      '@odata.type': TEXT_WEBPART_PROPERTIES_TYPE,
      data: {
        content: {
          formattedValue: innerHtml,
          value: htmlToPlainText(innerHtml),
        },
      },
    },
  };
}

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
   * `.../webParts/{webpart-id}` — the dedicated PATCH / DELETE endpoint Graph
   * documents for per-web-part operations. NOTE: PR4 used a `canvasLayout/
   * horizontalSections/columns/webparts/{id}` path with empty section/column
   * segments; that form is undocumented and Graph returns `Resource not found`
   * for both PATCH and DELETE (live-tested 2026-05). Use `/webParts/{id}`
   * (camelCase, no canvas segment) as per the official endpoint docs.
   * @param pageId - Graph id of the page
   * @param webpartId - Graph id of the web part
   */
  webpartItemPath(pageId: string, webpartId: string): string {
    return `${this.pagePath(pageId)}/webParts/${webpartId}`;
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
   * `PATCH .../{page-id}/microsoft.graph.sitePage` — replace the canvasLayout
   * (Graph requires the FULL layout). Convenience wrapper around `patchPage`
   * kept for backwards compatibility with callers that only update the layout.
   * @param pageId - target page id
   * @param canvasLayout - complete canvasLayout
   */
  updatePage(pageId: string, canvasLayout: unknown): Promise<unknown> {
    return this.patchPage(pageId, { canvasLayout });
  }

  /**
   * `PATCH .../{page-id}/microsoft.graph.sitePage` with an arbitrary subset of
   * sitePage properties (title, description, showComments, titleArea,
   * canvasLayout, …). Used by tools that need to update metadata without
   * touching the layout. When `canvasLayout` is present, UI-only fields
   * (see `UI_ONLY_WEBPART_FIELDS`) are stripped automatically — these are
   * written by the SharePoint editor on Save but Graph PATCH rejects them.
   * @param pageId - target page id
   * @param body - partial sitePage payload
   */
  patchPage(pageId: string, body: Record<string, unknown>): Promise<unknown> {
    const cleaned =
      body.canvasLayout !== undefined
        ? { ...body, canvasLayout: stripUiOnlyWebPartFields(body.canvasLayout) }
        : body;
    return this.graph.graphRequest('PATCH', this.pagePath(pageId), cleaned);
  }

  /**
   * `POST` a text web part into the addressed section/column. Graph requires
   * the createWebPart envelope (envelope `@odata.type` + `webPartProperties`)
   * — the shorter PR4 shape (`@odata.type` + `innerHtml`) surfaces as 400.
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
      buildTextWebPartBody(innerHtml)
    );
  }

  /**
   * `PATCH` a text web part by id — replaces `innerHtml`. Uses the same
   * createWebPart envelope as the POST path.
   * @param pageId - target page id
   * @param webpartId - Graph id of the web part
   * @param innerHtml - new HTML body
   */
  updateTextWebPart(pageId: string, webpartId: string, innerHtml: string): Promise<unknown> {
    return this.graph.graphRequest(
      'PATCH',
      this.webpartItemPath(pageId, webpartId),
      buildTextWebPartBody(innerHtml)
    );
  }

  /**
   * `POST` a standard (non-text) web part into the addressed section/column.
   * The `data` payload is web-part-type-specific — Graph docs do not publish
   * per-type schemas, so callers must supply the right shape (consult the
   * SharePoint UI / SPFx docs / PnPjs examples). Passing `undefined` creates
   * the web part with Graph defaults.
   * @param pageId - target page id
   * @param sectionId - section Graph id
   * @param columnId - column Graph id within the section
   * @param webPartType - GUID from `STANDARD_WEBPART_TYPES`
   * @param data - optional `webPartData` payload
   */
  addStandardWebPart<T = unknown>(
    pageId: string,
    sectionId: string,
    columnId: string,
    webPartType: string,
    data?: Record<string, unknown>
  ): Promise<T | undefined> {
    return this.graph.graphRequest<T>(
      'POST',
      this.webpartsCollectionPath(pageId, sectionId, columnId),
      buildStandardWebPartBody(webPartType, data)
    );
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
