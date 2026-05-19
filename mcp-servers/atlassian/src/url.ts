/**
 * URL helpers for the Atlassian worker.
 * @module mcp-atlassian/url
 */

import { ts } from '@speedwave/mcp-shared';

/**
 * Build the human `/browse/<key>` URL for a Jira issue or project from its `self`
 * API URL. Returns `undefined` if `selfUrl` isn't a parseable URL (the API
 * unexpectedly changed its `self` format) — logged at warn level so the change
 * is visible.
 * @param selfUrl - The resource's `self` API URL.
 * @param key - The Jira issue or project key.
 * @returns The `https://<host>/browse/<key>` URL, or `undefined` on failure.
 */
export function deriveBrowseUrl(selfUrl: string, key: string): string | undefined {
  try {
    return `${new URL(selfUrl).origin}/browse/${key}`;
  } catch {
    console.warn(`${ts()} [mcp-atlassian] Could not derive a browse URL from self='${selfUrl}'`);
    return undefined;
  }
}
