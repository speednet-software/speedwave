/**
 * Confluence spaces — listing (allowlist-filtered) and single-space lookup, via the v2 API
 * (`/wiki/api/v2/spaces`).
 * @module mcp-atlassian/domains/confluence-spaces
 */

import { clampPageSize } from '@speedwave/mcp-shared';
import type { AtlassianClient } from '../client.js';
import { assertConfluenceSpaceAllowed, filterByAllowlist } from '../scope.js';
import type { ConfluenceSpace } from '../types.js';

/** Client for Confluence space operations. */
export interface ConfluenceSpacesClient {
  /** List spaces visible to the account (filtered by the configured allowlist, if any). */
  list(options?: { keys?: string[]; limit?: number }): Promise<ConfluenceSpace[]>;
  /** Get a single space by key. */
  getByKey(spaceKey: string): Promise<ConfluenceSpace>;
}

/**
 * Create a {@link ConfluenceSpacesClient} from the shared Atlassian HTTP client.
 * @param client - The shared Atlassian HTTP client.
 * @returns A Confluence spaces client.
 */
export function createConfluenceSpacesClient(client: AtlassianClient): ConfluenceSpacesClient {
  return {
    async list(options = {}) {
      const params: Record<string, unknown> = {
        limit: clampPageSize(options.limit, 50, 100),
      };
      if (options.keys && options.keys.length > 0) params.keys = options.keys.join(',');
      const res = await client.get<{ results?: unknown[] }>('/wiki/api/v2/spaces', params);
      const spaces = (res.results ?? []).map(mapSpace);
      return filterByAllowlist(spaces, (s) => s.key, client.confluenceSpaceKeys);
    },

    async getByKey(spaceKey) {
      assertConfluenceSpaceAllowed(spaceKey, client.confluenceSpaceKeys);
      const res = await client.get<{ results?: unknown[] }>('/wiki/api/v2/spaces', {
        keys: spaceKey,
        limit: 1,
      });
      const first = res.results?.[0];
      if (!first) throw new Error(`Confluence space '${spaceKey}' not found`);
      return mapSpace(first);
    },
  };
}

/**
 * Map a v2 space object to {@link ConfluenceSpace}.
 * @param raw - The raw object as returned by the Atlassian REST API.
 */
export function mapSpace(raw: unknown): ConfluenceSpace {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(o.id ?? ''),
    key: String(o.key ?? ''),
    name: String(o.name ?? ''),
    type: o.type ? String(o.type) : undefined,
    status: o.status ? String(o.status) : undefined,
  };
}
