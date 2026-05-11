/**
 * Confluence pages — CQL search (v1), and page CRUD via the v2 API. `update`
 * needs the current `version.number` (+1), which this client fetches
 * automatically so callers never have to.
 * @module mcp-atlassian/domains/confluence-pages
 */

import type { AtlassianClient } from '../client.js';
import { assertConfluenceSpaceAllowed, storageBody, textToStorage } from '../adf.js';
import type { ConfluencePage } from '../types.js';

/** A page body supplied to create/update: raw storage XHTML, or plain text. */
type BodyInput = { storage?: string; text?: string };

/** Client for Confluence page operations. */
export interface ConfluencePagesClient {
  /**
   * Search content with CQL (Confluence Query Language) via the v1 search API
   * (v2 has no CQL equivalent). Returns matched pages, normalised to v2 shape
   * where possible (best-effort — search results omit version/body).
   */
  search(params: { cql: string; limit?: number }): Promise<ConfluencePage[]>;
  /** Get a page by ID (v2), optionally including the storage-format body. */
  get(pageId: string, options?: { includeBody?: boolean }): Promise<ConfluencePage>;
  /** Find a page by exact title within a space (v2). Throws if not found. */
  getByTitle(
    spaceKey: string,
    title: string,
    options?: { includeBody?: boolean }
  ): Promise<ConfluencePage>;
  /** Create a page in a space (v2). `body` is raw storage XHTML or plain text. */
  create(params: {
    spaceKey: string;
    title: string;
    body: BodyInput;
    parentId?: string;
  }): Promise<ConfluencePage>;
  /**
   * Update a page (v2). The current version is fetched automatically and
   * incremented. Only provided fields change.
   */
  update(pageId: string, params: { title?: string; body?: BodyInput }): Promise<ConfluencePage>;
  /** List the direct child pages of a page (v2). */
  getChildren(pageId: string, options?: { limit?: number }): Promise<ConfluencePage[]>;
}

/**
 * Create a Confluence pages client.
 * @param client - The shared Atlassian HTTP client.
 * @returns A {@link ConfluencePagesClient}.
 */
export function createConfluencePagesClient(client: AtlassianClient): ConfluencePagesClient {
  /** Resolve a space ID → space key, caching within the client instance. */
  const spaceKeyCache = new Map<string, string>();
  const resolveSpaceKey = async (spaceId: string): Promise<string | undefined> => {
    if (!spaceId) return undefined;
    if (spaceKeyCache.has(spaceId)) return spaceKeyCache.get(spaceId);
    try {
      const sp = await client.get<{ key?: string }>(
        `/wiki/api/v2/spaces/${encodeURIComponent(spaceId)}`
      );
      const key = sp.key ? String(sp.key) : undefined;
      if (key) spaceKeyCache.set(spaceId, key);
      return key;
    } catch {
      return undefined;
    }
  };

  /**
   * Resolve a space key → space ID (v2 create/get-by-title need the ID).
   * @param spaceKey - The Confluence space key.
   */
  const resolveSpaceId = async (spaceKey: string): Promise<string> => {
    const res = await client.get<{ results?: Array<{ id?: string; key?: string }> }>(
      '/wiki/api/v2/spaces',
      { keys: spaceKey, limit: 1 }
    );
    const id = res.results?.[0]?.id;
    if (!id) throw new Error(`Confluence space '${spaceKey}' not found`);
    if (res.results?.[0]?.key) spaceKeyCache.set(String(id), String(res.results[0].key));
    return String(id);
  };

  const enrich = async (page: ConfluencePage): Promise<ConfluencePage> => {
    const key = page.space_key ?? (await resolveSpaceKey(page.space_id));
    const enriched = { ...page, space_key: key };
    assertConfluenceSpaceAllowed(key, client.confluenceSpaceKeys);
    return enriched;
  };

  /**
   * Build the v2 `body` payload from a {@link BodyInput}.
   * @param body - The page/comment body to send (raw storage XHTML, or plain text).
   */
  const bodyPayload = (body: BodyInput): { representation: 'storage'; value: string } => {
    if (body.storage !== undefined) return storageBody(body.storage);
    return storageBody(textToStorage(body.text ?? ''));
  };

  return {
    async search({ cql, limit = 25 }) {
      const res = await client.get<{ results?: unknown[] }>('/wiki/rest/api/content/search', {
        cql,
        limit: Math.min(Math.max(limit, 1), 100),
      });
      const pages = (res.results ?? [])
        .map(mapV1SearchResult)
        .filter((p): p is ConfluencePage => p !== null);
      // Best-effort space-key enforcement: drop pages outside the allowlist.
      if (client.confluenceSpaceKeys.length === 0) return pages;
      const allowed = client.confluenceSpaceKeys.map((k) => k.toUpperCase());
      return pages.filter((p) => p.space_key && allowed.includes(p.space_key.toUpperCase()));
    },

    async get(pageId, options = {}) {
      const params: Record<string, unknown> = {};
      if (options.includeBody) params['body-format'] = 'storage';
      const raw = await client.get<unknown>(
        `/wiki/api/v2/pages/${encodeURIComponent(pageId)}`,
        params
      );
      return enrich(mapV2Page(raw));
    },

    async getByTitle(spaceKey, title, options = {}) {
      assertConfluenceSpaceAllowed(spaceKey, client.confluenceSpaceKeys);
      const spaceId = await resolveSpaceId(spaceKey);
      const params: Record<string, unknown> = { 'space-id': spaceId, title, limit: 1 };
      if (options.includeBody) params['body-format'] = 'storage';
      const res = await client.get<{ results?: unknown[] }>('/wiki/api/v2/pages', params);
      const first = res.results?.[0];
      if (!first)
        throw new Error(`Confluence page titled '${title}' not found in space '${spaceKey}'`);
      return enrich(mapV2Page(first));
    },

    async create({ spaceKey, title, body, parentId }) {
      assertConfluenceSpaceAllowed(spaceKey, client.confluenceSpaceKeys);
      const spaceId = await resolveSpaceId(spaceKey);
      const data: Record<string, unknown> = {
        spaceId,
        status: 'current',
        title,
        body: bodyPayload(body),
      };
      if (parentId) data.parentId = parentId;
      const raw = await client.post<unknown>('/wiki/api/v2/pages', data);
      return enrich(mapV2Page(raw));
    },

    async update(pageId, { title, body }) {
      // Fetch current page (need version + status + existing title/space).
      const current = await client.get<unknown>(`/wiki/api/v2/pages/${encodeURIComponent(pageId)}`);
      const page = mapV2Page(current);
      const key = page.space_key ?? (await resolveSpaceKey(page.space_id));
      assertConfluenceSpaceAllowed(key, client.confluenceSpaceKeys);
      const data: Record<string, unknown> = {
        id: pageId,
        status: page.status || 'current',
        title: title ?? page.title,
        version: { number: page.version + 1 },
      };
      if (body !== undefined) data.body = bodyPayload(body);
      const raw = await client.put<unknown>(
        `/wiki/api/v2/pages/${encodeURIComponent(pageId)}`,
        data
      );
      return enrich({ ...mapV2Page(raw), space_key: key });
    },

    async getChildren(pageId, options = {}) {
      const res = await client.get<{ results?: unknown[] }>(
        `/wiki/api/v2/pages/${encodeURIComponent(pageId)}/children`,
        { limit: Math.min(Math.max(options.limit ?? 25, 1), 100) }
      );
      // Children come back without spaceId/version detail; map best-effort.
      return (res.results ?? []).map(mapV2ChildPage);
    },
  };
}

//═══════════════════════════════════════════════════════════════════════════════
// Normalisers
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Map a v2 page object to {@link ConfluencePage}.
 * @param raw - The raw object as returned by the Atlassian REST API.
 */
export function mapV2Page(raw: unknown): ConfluencePage {
  const o = (raw ?? {}) as Record<string, unknown>;
  const version = (o.version ?? {}) as Record<string, unknown>;
  const body = (o.body ?? {}) as Record<string, unknown>;
  const storage = (body.storage ?? {}) as Record<string, unknown>;
  const links = (o._links ?? {}) as Record<string, unknown>;
  return {
    id: String(o.id ?? ''),
    status: String(o.status ?? 'current'),
    title: String(o.title ?? ''),
    space_id: String(o.spaceId ?? ''),
    parent_id: o.parentId != null ? String(o.parentId) : null,
    version: Number(version.number ?? 1),
    body_storage: storage.value != null ? String(storage.value) : undefined,
    web_url: links.webui ? String(links.webui) : undefined,
  };
}

/**
 * Map a v2 child-page object (no spaceId/version) to {@link ConfluencePage}.
 * @param raw - The raw object as returned by the Atlassian REST API.
 */
export function mapV2ChildPage(raw: unknown): ConfluencePage {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(o.id ?? ''),
    status: String(o.status ?? 'current'),
    title: String(o.title ?? ''),
    space_id: o.spaceId != null ? String(o.spaceId) : '',
    parent_id: o.parentId != null ? String(o.parentId) : null,
    version: Number((o.version as Record<string, unknown> | undefined)?.number ?? 0),
  };
}

/**
 * Map a v1 `/content/search` result to {@link ConfluencePage} (best-effort).
 * @param raw - The raw object as returned by the Atlassian REST API.
 */
export function mapV1SearchResult(raw: unknown): ConfluencePage | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (o.type && o.type !== 'page') return null;
  const space = (o.space ?? {}) as Record<string, unknown>;
  const version = (o.version ?? {}) as Record<string, unknown>;
  const links = (o._links ?? {}) as Record<string, unknown>;
  return {
    id: String(o.id ?? ''),
    status: String(o.status ?? 'current'),
    title: String(o.title ?? ''),
    space_id: space.id != null ? String(space.id) : '',
    space_key: space.key ? String(space.key) : undefined,
    parent_id: null,
    version: Number(version.number ?? 0),
    web_url: links.webui ? String(links.webui) : undefined,
  };
}
