/**
 * Graph URL builders for the SharePoint Pages API.
 * Site id is always resolved through `GraphRequester.getSiteId()` — no tool accepts `site_id` from the model (ADR-060).
 */
import type { GraphRequester } from './site-client.js';

/** Graph cast segment that scopes a generic `baseSitePage` to a `sitePage`. */
export const PAGE_RESOURCE = 'microsoft.graph.sitePage';
/** `@odata.type` discriminators for the createWebPart endpoint (envelope and properties types differ in capitalisation). */
export const TEXT_WEBPART_ENVELOPE_TYPE = '#microsoft.graph.textwebpart';
export const TEXT_WEBPART_PROPERTIES_TYPE = '#microsoft.graph.textwebPart';
export const STANDARD_WEBPART_ENVELOPE_TYPE = '#microsoft.graph.standardwebpart';

/** SSOT map of human-friendly web-part names to the GUIDs Graph expects in `webPartType`. */
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
 * Extract headings (h1-h6) from text web part HTML, assigning anchor ids when missing.
 * @param innerHtml - text web part HTML
 * @returns headings discovered in source order
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
    // Deduplicate within a single web part for deterministic click-through.
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
 * Rewrite `innerHtml` so every heading carries the matching anchor `id`; headings with an id keep it.
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

/** Regex for `<h1>`…`<h6>` blocks; fresh instance each call to avoid `/g` mutable `lastIndex`. */
function headingRegex(): RegExp {
  return /<h([1-6])(\s[^>]*)?>([\s\S]*?)<\/h\1>/gi;
}

/**
 * Slugify a heading to an anchor (lower-case, alphanumeric + dashes, never empty).
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
 * Render ToC HTML from headings (nested lists inside the parent `<li>`, levels skip gracefully).
 * @param headings - extracted headings (h1-h6, preserving order)
 * @param title - optional header rendered above the ToC (`<h2>`)
 * @returns HTML string suitable for a text web part body
 */
export function renderTableOfContents(headings: TocHeading[], title?: string): string {
  if (headings.length === 0) {
    return title ? `<h2>${escapeHtml(title)}</h2>` : '';
  }
  const titleHtml = title ? `<h2>${escapeHtml(title)}</h2>` : '';
  // Stack of open elements: 'ul' for lists, 'li' for items.
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
      // Descend: open a <ul> per level, bridging gaps with empty <li><ul>.
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
      // Ascend: close lists to the target depth, then close the open sibling <li>.
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

/** Fields the SharePoint UI writes but Graph PATCH refuses on round-trip (e.g. `customContentDropSupport`). */
export const UI_ONLY_WEBPART_FIELDS = ['customContentDropSupport'] as const;

/**
 * Recursively remove UI-only fields from a canvasLayout so it can be re-PATCHed via `updatePage` (deep clone, any depth).
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
 * Build an image web part `data` payload pinned to a driveItem in the site's drive (`imageSourceType: 2`).
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
 * Build the createWebPart envelope for standard (non-text) web parts.
 * @param webPartType - GUID of the standard web part type
 * @param data - optional webPartData payload (audiences, properties, serverProcessedContent, title, ...)
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
 * Strip HTML tags + decode safe entities, leaving `&lt;`/`&gt;` as entities (see ADR for XSS rationale).
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
      // Decode `&amp;` LAST so `&amp;lt;` decodes to `&lt;`, never to `<`.
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Build the createWebPart envelope for text web parts (inner `value` derived from `innerHtml`).
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

/** Builder of Graph paths for the pages domain (stateless apart from the shared {@link GraphRequester}). */
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
   * `.../webParts/{webpart-id}` — PATCH / DELETE endpoint (the canvas-segment form returns 404).
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
   * `PATCH .../{page-id}/microsoft.graph.sitePage` — replace the (full) canvasLayout.
   * @param pageId - target page id
   * @param canvasLayout - complete canvasLayout
   */
  updatePage(pageId: string, canvasLayout: unknown): Promise<unknown> {
    return this.patchPage(pageId, { canvasLayout });
  }

  /**
   * `PATCH .../{page-id}/microsoft.graph.sitePage` with a subset of sitePage properties; strips `UI_ONLY_WEBPART_FIELDS` from any `canvasLayout`.
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
      buildTextWebPartBody(innerHtml)
    );
  }

  /**
   * `PATCH` a text web part by id — replaces `innerHtml`.
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
