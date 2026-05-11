/**
 * Confluence page-level content — footer comments, labels, and attachments,
 * via the v2 API.
 * @module mcp-atlassian/domains/confluence-content
 */

import type { AtlassianClient } from '../client.js';
import { assertConfluenceSpaceAllowed, storageBody, textToStorage } from '../adf.js';
import type { ConfluenceAttachment, ConfluenceComment, ConfluenceLabel } from '../types.js';

/** Client for Confluence page-content operations. */
export interface ConfluenceContentClient {
  /** Add a footer comment to a page. `body` is raw storage XHTML or plain text. */
  addComment(pageId: string, body: { storage?: string; text?: string }): Promise<ConfluenceComment>;
  /** List footer comments on a page. */
  getComments(pageId: string, options?: { limit?: number }): Promise<ConfluenceComment[]>;
  /** Add labels to a page (each `prefix` defaults to `global`). */
  addLabels(pageId: string, labels: string[]): Promise<ConfluenceLabel[]>;
  /** List labels on a page. */
  getLabels(pageId: string, options?: { limit?: number }): Promise<ConfluenceLabel[]>;
  /** List attachments on a page (metadata only — no download). */
  listAttachments(pageId: string, options?: { limit?: number }): Promise<ConfluenceAttachment[]>;
}

/**
 * Create a Confluence page-content client.
 * @param client - The shared Atlassian HTTP client.
 * @returns A {@link ConfluenceContentClient}.
 */
export function createConfluenceContentClient(client: AtlassianClient): ConfluenceContentClient {
  /**
   * Enforce the space allowlist for a page by resolving its space.
   * @param pageId - The Confluence page ID.
   */
  const enforcePage = async (pageId: string): Promise<void> => {
    if (client.confluenceSpaceKeys.length === 0) return;
    const page = await client.get<{ spaceId?: string }>(
      `/wiki/api/v2/pages/${encodeURIComponent(pageId)}`
    );
    let key: string | undefined;
    if (page.spaceId) {
      try {
        const sp = await client.get<{ key?: string }>(
          `/wiki/api/v2/spaces/${encodeURIComponent(String(page.spaceId))}`
        );
        key = sp.key ? String(sp.key) : undefined;
      } catch {
        key = undefined;
      }
    }
    assertConfluenceSpaceAllowed(key, client.confluenceSpaceKeys);
  };

  return {
    async addComment(pageId, body) {
      await enforcePage(pageId);
      const value =
        body.storage !== undefined
          ? storageBody(body.storage)
          : storageBody(textToStorage(body.text ?? ''));
      const raw = await client.post<unknown>('/wiki/api/v2/footer-comments', {
        pageId,
        body: value,
      });
      return mapComment(raw, pageId);
    },

    async getComments(pageId, options = {}) {
      await enforcePage(pageId);
      const res = await client.get<{ results?: unknown[] }>(
        `/wiki/api/v2/pages/${encodeURIComponent(pageId)}/footer-comments`,
        { limit: Math.min(Math.max(options.limit ?? 25, 1), 100), 'body-format': 'storage' }
      );
      return (res.results ?? []).map((c) => mapComment(c, pageId));
    },

    async addLabels(pageId, labels) {
      await enforcePage(pageId);
      // v2 has no bulk-add; the v1 endpoint accepts an array.
      const payload = labels.map((name) => ({ prefix: 'global', name }));
      const res = await client.post<{ results?: unknown[] }>(
        `/wiki/rest/api/content/${encodeURIComponent(pageId)}/label`,
        payload
      );
      return (res.results ?? []).map(mapLabel);
    },

    async getLabels(pageId, options = {}) {
      await enforcePage(pageId);
      const res = await client.get<{ results?: unknown[] }>(
        `/wiki/api/v2/pages/${encodeURIComponent(pageId)}/labels`,
        { limit: Math.min(Math.max(options.limit ?? 50, 1), 100) }
      );
      return (res.results ?? []).map(mapLabel);
    },

    async listAttachments(pageId, options = {}) {
      await enforcePage(pageId);
      const res = await client.get<{ results?: unknown[] }>(
        `/wiki/api/v2/pages/${encodeURIComponent(pageId)}/attachments`,
        { limit: Math.min(Math.max(options.limit ?? 50, 1), 100) }
      );
      return (res.results ?? []).map((a) => mapAttachment(a, pageId));
    },
  };
}

//═══════════════════════════════════════════════════════════════════════════════
// Normalisers
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Map a v2 footer-comment object to {@link ConfluenceComment}.
 * @param raw - The raw object as returned by the Atlassian REST API.
 * @param pageId - The Confluence page ID.
 */
export function mapComment(raw: unknown, pageId: string): ConfluenceComment {
  const o = (raw ?? {}) as Record<string, unknown>;
  const version = (o.version ?? {}) as Record<string, unknown>;
  const body = (o.body ?? {}) as Record<string, unknown>;
  const storage = (body.storage ?? {}) as Record<string, unknown>;
  return {
    id: String(o.id ?? ''),
    page_id: o.pageId != null ? String(o.pageId) : pageId,
    body_storage: storage.value != null ? String(storage.value) : '',
    version: Number(version.number ?? 1),
    created_at: version.createdAt ? String(version.createdAt) : undefined,
  };
}

/**
 * Map a label object (v1 or v2 shape) to {@link ConfluenceLabel}.
 * @param raw - The raw object as returned by the Atlassian REST API.
 */
export function mapLabel(raw: unknown): ConfluenceLabel {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    id: o.id != null ? String(o.id) : '',
    name: String(o.name ?? ''),
    prefix: o.prefix ? String(o.prefix) : undefined,
  };
}

/**
 * Map a v2 attachment object to {@link ConfluenceAttachment}.
 * @param raw - The raw object as returned by the Atlassian REST API.
 * @param pageId - The Confluence page ID.
 */
export function mapAttachment(raw: unknown, pageId: string): ConfluenceAttachment {
  const o = (raw ?? {}) as Record<string, unknown>;
  const links = (o._links ?? {}) as Record<string, unknown>;
  return {
    id: String(o.id ?? ''),
    title: String(o.title ?? ''),
    media_type: o.mediaType ? String(o.mediaType) : undefined,
    file_size: o.fileSize != null ? Number(o.fileSize) : undefined,
    page_id: o.pageId != null ? String(o.pageId) : pageId,
    download_url: links.download ? String(links.download) : undefined,
  };
}
