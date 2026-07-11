/**
 * Confluence pages — CQL search (v1), and page CRUD via the v2 API.
 * @module mcp-atlassian/domains/confluence-pages
 */

import { clampPageSize } from '@speedwave/mcp-shared';
import type { AtlassianClient } from '../client.js';
import { resolveBodyPayload, type StorageBodyInput } from '../adf.js';
import { assertConfluenceSpaceAllowed, filterByAllowlist } from '../scope.js';
import { resolveConfluenceSpaceKey } from './confluence-space-resolver.js';
import type { ConfluencePage } from '../types.js';

/** A full Confluence page — like {@link ConfluencePage} but with a known version. */
type FullPage = ConfluencePage & { version: number };

/** Client for Confluence page operations. */
export interface ConfluencePagesClient {
  /**
   * Search content with CQL (v1 API); results are best-effort normalised to v2 shape,
   * omitting version/body.
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
    body: StorageBodyInput;
    parentId?: string;
  }): Promise<ConfluencePage>;
  /**
   * Update a page (v2); the current version is fetched and incremented automatically.
   * Only provided fields change.
   */
  update(
    pageId: string,
    params: { title?: string; body?: StorageBodyInput }
  ): Promise<ConfluencePage>;
  /** List the direct child pages of a page (v2). */
  getChildren(pageId: string, options?: { limit?: number }): Promise<ConfluencePage[]>;
}

/**
 * Create a {@link ConfluencePagesClient} from the shared Atlassian HTTP client.
 * @param client - The shared Atlassian HTTP client.
 * @returns A {@link ConfluencePagesClient}.
 */
export function createConfluencePagesClient(client: AtlassianClient): ConfluencePagesClient {
  /** Resolve a space ID → space key, caching within the client instance. */
  const spaceKeyCache = new Map<string, string>();
  /**
   * Resolve a space ID → key via the cache or {@link resolveConfluenceSpaceKey}; `pageId`
   * is included in error context.
   * @param spaceId - The Confluence space ID from a page payload.
   * @param pageId - Optional page ID, included in error context.
   */
  const resolveSpaceKey = async (spaceId: string, pageId?: string): Promise<string | undefined> => {
    if (!spaceId) return undefined;
    if (spaceKeyCache.has(spaceId)) return spaceKeyCache.get(spaceId);
    const key = await resolveConfluenceSpaceKey(client, spaceId, pageId);
    if (key) spaceKeyCache.set(spaceId, key);
    return key;
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

  // Resolve the page's space key and enforce the allowlist. Skips the lookup
  // entirely when no allowlist is configured: nothing to enforce.
  const enrich = async <T extends ConfluencePage>(page: T): Promise<T> => {
    if (client.confluenceSpaceKeys.length === 0) return page;
    const key = page.space_key ?? (await resolveSpaceKey(page.space_id, page.id));
    const enriched = { ...page, space_key: key };
    assertConfluenceSpaceAllowed(key, client.confluenceSpaceKeys);
    return enriched;
  };

  return {
    async search({ cql, limit = 25 }) {
      const res = await client.get<{ results?: unknown[] }>('/wiki/rest/api/content/search', {
        cql,
        limit: clampPageSize(limit, 25, 100),
      });
      const pages = (res.results ?? [])
        .map(mapV1SearchResult)
        .filter((p): p is ConfluencePage => p !== null);
      // Best-effort space-key enforcement on v1 search results.
      return filterByAllowlist(pages, (p) => p.space_key, client.confluenceSpaceKeys);
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
        body: resolveBodyPayload(body),
      };
      if (parentId) data.parentId = parentId;
      const raw = await client.post<unknown>('/wiki/api/v2/pages', data);
      return enrich(mapV2Page(raw));
    },

    async update(pageId, { title, body }) {
      // Fetch current page (need version + status + existing title/space).
      const current = await client.get<unknown>(`/wiki/api/v2/pages/${encodeURIComponent(pageId)}`);
      const page = mapV2Page(current);
      let key = page.space_key;
      if (client.confluenceSpaceKeys.length > 0) {
        key = key ?? (await resolveSpaceKey(page.space_id, pageId));
        assertConfluenceSpaceAllowed(key, client.confluenceSpaceKeys);
      }
      const data: Record<string, unknown> = {
        id: pageId,
        status: page.status || 'current',
        title: title ?? page.title,
        version: { number: page.version + 1 },
      };
      if (body !== undefined) data.body = resolveBodyPayload(body);
      const raw = await client.put<unknown>(
        `/wiki/api/v2/pages/${encodeURIComponent(pageId)}`,
        data
      );
      return enrich({ ...mapV2Page(raw), space_key: key });
    },

    async getChildren(pageId, options = {}) {
      // Enforce the space allowlist before listing children.
      if (client.confluenceSpaceKeys.length > 0) {
        await enrich(
          mapV2Page(await client.get<unknown>(`/wiki/api/v2/pages/${encodeURIComponent(pageId)}`))
        );
      }
      const res = await client.get<{ results?: unknown[] }>(
        `/wiki/api/v2/pages/${encodeURIComponent(pageId)}/children`,
        { limit: clampPageSize(options.limit, 25, 100) }
      );
      // Children come back without spaceId/version detail; map best-effort.
      return (res.results ?? []).map(mapV2ChildPage);
    },
  };
}

// ── Normalisers ──────────────────────────────────────────────────────────────

/**
 * Map a v2 page object to {@link ConfluencePage}. A full page response always carries a version,
 * so the result type narrows `version` to `number`.
 * @param raw - The raw object as returned by the Atlassian REST API.
 * @returns The normalised page.
 */
export function mapV2Page(raw: unknown): FullPage {
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
 * Map a v2 child-page object to {@link ConfluencePage}. Child-listing responses carry no `spaceId`
 * or `version` detail (`version` is `null`) — callers must re-fetch via `getPage` before updating.
 * @param raw - The raw object as returned by the Atlassian REST API.
 * @returns The normalised (partial) page.
 */
export function mapV2ChildPage(raw: unknown): ConfluencePage {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(o.id ?? ''),
    status: String(o.status ?? 'current'),
    title: String(o.title ?? ''),
    space_id: o.spaceId != null ? String(o.spaceId) : '',
    parent_id: o.parentId != null ? String(o.parentId) : null,
    version: null,
  };
}

/**
 * Map a v1 `/content/search` result to {@link ConfluencePage} (best-effort, `version` is `null`).
 * Returns `null` if the result isn't a page.
 * @param raw - The raw object as returned by the Atlassian REST API.
 * @returns The normalised (partial) page, or `null` if the result isn't a page.
 */
export function mapV1SearchResult(raw: unknown): ConfluencePage | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (o.type && o.type !== 'page') return null;
  const space = (o.space ?? {}) as Record<string, unknown>;
  const links = (o._links ?? {}) as Record<string, unknown>;
  return {
    id: String(o.id ?? ''),
    status: String(o.status ?? 'current'),
    title: String(o.title ?? ''),
    space_id: space.id != null ? String(space.id) : '',
    space_key: space.key ? String(space.key) : undefined,
    parent_id: null,
    version: null,
    web_url: links.webui ? String(links.webui) : undefined,
  };
}
