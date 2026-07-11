/**
 * URL helpers for the Atlassian worker.
 * @module mcp-atlassian/url
 */

import { ts } from '@speedwave/mcp-shared';

/**
 * Build the human `/browse/<key>` URL from `selfUrl`; `undefined` if unparseable (warn-logged).
 * @param selfUrl - The resource's `self` API URL.
 * @param key - The Jira issue or project key.
 * @returns The `https://<host>/browse/<key>` URL, or `undefined` if `selfUrl` is not parseable.
 */
export function deriveBrowseUrl(selfUrl: string, key: string): string | undefined {
  try {
    return `${new URL(selfUrl).origin}/browse/${key}`;
  } catch {
    console.warn(`${ts()} [mcp-atlassian] Could not derive a browse URL from self='${selfUrl}'`);
    return undefined;
  }
}
