/**
 * Shared space-key resolution for the Confluence page and content domains.
 * @module mcp-atlassian/domains/confluence-space-resolver
 */

import { ts } from '@speedwave/mcp-shared';
import type { AtlassianClient } from '../client.js';

/**
 * Resolve a Confluence space ID to its key. A 404 means the space has no
 * resolvable key (allowlist denial); any other lookup failure is rethrown,
 * carrying the space (and page, when known) ID for the caller to log/report.
 * @param client - The shared Atlassian HTTP client.
 * @param spaceId - The Confluence space ID from a page payload.
 * @param pageId - The page the lookup is for, included in the error context.
 */
export async function resolveConfluenceSpaceKey(
  client: AtlassianClient,
  spaceId: string,
  pageId?: string
): Promise<string | undefined> {
  if (!spaceId) return undefined;
  try {
    const sp = await client.get<{ key?: string }>(
      `/wiki/api/v2/spaces/${encodeURIComponent(spaceId)}`
    );
    return sp.key ? String(sp.key) : undefined;
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status === 404) return undefined;
    const context = pageId ? ` for page '${pageId}'` : '';
    console.warn(
      `${ts()} [mcp-atlassian] Failed to resolve Confluence space id '${spaceId}'${context}: ${error}`
    );
    throw new Error(
      `Could not verify Confluence space '${spaceId}'${context} (space lookup failed); retry, or confirm the space is accessible.`
    );
  }
}
